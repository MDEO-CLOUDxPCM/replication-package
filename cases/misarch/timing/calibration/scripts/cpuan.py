"""Helpers to analyse cpumon output (cpu.csv / host.csv)."""
import bisect
import csv
import json
import os

from cronjobs import cron_instants  # noqa: F401  (re-exported)
from stack import AGG, PREFIX, TOPOLOGY, short


MONGO_DBS = ["misarch-%s-db-1" % x for x in ("order", "review", "shoppingcart", "wishlist", "invoice", "payment",
                                             "inventory")]


def despike(ts, us, thr_us=200_000, pair_thr_us=300_000, win=10):
    """Remove healthcheck bursts (mongosh, ~450 ms CPU every 60 s) from a cumulative usage series: 1 s increments
    exceeding the local median (+-win samples) by thr (or two consecutive ones by pair_thr together) are replaced by
    the local median. Returns (new cumulative series, number of removed bursts, removed CPU in usec)."""
    import statistics
    inc = [us[i + 1] - us[i] for i in range(len(us) - 1)]
    out = inc[:]
    n, removed = 0, 0
    i = 0
    while i < len(inc):
        lo, hi = max(0, i - win), min(len(inc), i + win + 1)
        med = statistics.median(inc[lo:hi])
        if inc[i] - med > thr_us:
            removed += inc[i] - med
            out[i] = med
            n += 1
        elif i + 1 < len(inc) and inc[i] - med > 80_000 and inc[i + 1] - med > 80_000 and \
                inc[i] + inc[i + 1] - 2 * med > pair_thr_us:
            removed += inc[i] + inc[i + 1] - 2 * med
            out[i] = out[i + 1] = med
            n += 1
            i += 1
        i += 1
    cum = [us[0]]
    for x in out:
        cum.append(cum[-1] + x)
    return cum, n, removed


def mask_instants(ts, us, instants, width_s, win=10):
    """Replace the 1-s increments of a cumulative usage series that overlap [i, i + width_s) of an instant by the
    median of the unmasked increments within +-win samples. Returns (new cumulative series, masked firings, removed
    CPU in usec)."""
    import statistics
    inc = [us[i + 1] - us[i] for i in range(len(us) - 1)]
    masked = [any(ts[i] < x + width_s and ts[i + 1] > x for x in instants) for i in range(len(inc))]
    out, removed = inc[:], 0
    for i, m in enumerate(masked):
        if m:
            near = [inc[j] for j in range(max(0, i - win), min(len(inc), i + win + 1)) if not masked[j]]
            med = statistics.median(near) if near else 0
            removed += inc[i] - med
            out[i] = med
    cum = [us[0]]
    for x in out:
        cum.append(cum[-1] + x)
    hit = sum(1 for x in instants if any(ts[i] < x + width_s and ts[i + 1] > x for i in range(len(inc))))
    return cum, hit, removed


class CpuData:
    def __init__(self, d, despike_keys=(), scheduled=()):
        """scheduled: [{"keys": [container keys], "cron": spring cron, "widthS": s, "ops": [...]}] - the CPU of
        scheduled jobs at their firing times is masked out of those containers (self.scheduled: per key the
        firings seen and the CPU removed, the jobs' measured cost)."""
        self.dir = d
        self.series = {}   # key -> ([t], [usage_usec], [throttled_usec], [nr_throttled])
        with open(os.path.join(d, "cpu.csv")) as f:
            r = csv.reader(f)
            next(r)
            for t, key, u, th, nth in r:
                s = self.series.setdefault(key, ([], [], [], []))
                s[0].append(float(t))
                s[1].append(int(u))
                s[2].append(int(th))
                s[3].append(int(nth))
        self.host = ([], [], [], [])  # t, busy_usec, load1, top
        self.vm = ([], [], [], [])    # t, pswpin, pswpout, pgmajfault (cumulative, pages / faults)
        self.steal = ([], [])         # t, steal_usec (cumulative; only where cpu.csv has the column)
        with open(os.path.join(d, "host.csv")) as f:
            r = csv.reader(f)
            next(r)
            for row in r:
                self.host[0].append(float(row[0]))
                self.host[1].append(int(row[1]))
                self.host[2].append(float(row[2]))
                self.host[3].append(row[3] if len(row) > 3 else "")
                if len(row) >= 7 and row[4] not in ("", "None"):
                    self.vm[0].append(float(row[0]))
                    self.vm[1].append(int(row[4]))
                    self.vm[2].append(int(row[5]))
                    self.vm[3].append(int(row[6]))
                if len(row) >= 8 and row[7] not in ("", "None"):
                    self.steal[0].append(float(row[0]))
                    self.steal[1].append(int(row[7]))
        try:
            self.info = json.load(open(os.path.join(d, "containers.json")))
        except Exception:
            self.info = {}
        self.synthetic = set()   # summed series of replicated units (architecture variants), not real containers
        try:
            topo = json.load(open(os.path.join(d, "topology.json")))
        except Exception:
            topo = None
        if topo:
            self._add_aggregates(topo)
        self.despiked = {}
        for k in despike_keys:
            if k in self.series and len(self.series[k][0]) > 30:
                cum, n, rem = despike(self.series[k][0], self.series[k][1])
                self.series[k] = (self.series[k][0], cum, self.series[k][2], self.series[k][3])
                self.despiked[k] = {"bursts": n, "removedCpuS": round(rem / 1e6, 3)}
        self.scheduled = {}
        for job in scheduled:
            for k in job["keys"]:
                s = self.series.get(k)
                if not s or len(s[0]) < 30:
                    continue
                inst = cron_instants(job["cron"], s[0][0], s[0][-1])
                cum, n, rem = mask_instants(s[0], s[1], inst, job.get("widthS", 3))
                self.series[k] = (s[0], cum, s[2], s[3])
                self.scheduled[k] = {"cron": job["cron"], "ops": job.get("ops", []), "firings": n,
                                     "removedCpuS": round(rem / 1e6, 4), "instants": [t for t in inst]}

    def _add_aggregates(self, topo):
        """Architecture variant: `sum:<plain container name>` = CPU of all replicas of a unit (app, and per member
        app-id its dapr and ecs sidecars); the per-replica containers stay as they are. cpumon samples every
        container at the same t, so the sum is taken over the time stamps present in all parts."""
        prefix = topo.get("prefix", "misarch-kotlin-")
        for name, parts in topo.get("aggregates", {}).items():
            keys = [f"{prefix}{c}-1" for c in parts]
            if not all(k in self.series for k in keys):
                continue
            idx = [dict(zip(self.series[k][0], range(len(self.series[k][0])))) for k in keys]
            common = [t for t in self.series[keys[0]][0] if all(t in ix for ix in idx[1:])]
            agg = ([], [], [], [])
            for t in common:
                agg[0].append(t)
                for j in (1, 2, 3):
                    agg[j].append(sum(self.series[k][j][ix[t]] for k, ix in zip(keys, idx)))
            key = f"{AGG}{prefix}{name}-1"
            self.series[key] = agg
            self.synthetic.add(key)
            lims = [self.info.get("containers", {}).get(k, {}).get("cpu.max") for k in keys]
            if all(lims) and all(l.split()[0] != "max" for l in lims):
                period = int(lims[0].split()[1])
                quota = sum(int(l.split()[0]) for l in lims)
                self.info.setdefault("containers", {})[key] = {"id": None, "cpu.max": f"{quota} {period}",
                                                               "parts": keys}

    @staticmethod
    def _at(ts, vals, t):
        """Linear interpolation of a cumulative counter at time t (clamped)."""
        i = bisect.bisect_left(ts, t)
        if i <= 0:
            return vals[0]
        if i >= len(ts):
            return vals[-1]
        t0, t1 = ts[i - 1], ts[i]
        v0, v1 = vals[i - 1], vals[i]
        if v1 < v0:   # counter reset (container restarted)
            return v1
        return v0 + (v1 - v0) * (t - t0) / (t1 - t0)

    def usec(self, key, t1, t2, idx=1):
        s = self.series.get(key)
        if not s or s[0][0] > t1 + 2 or s[0][-1] < t2 - 2:
            return None
        return self._at(s[0], s[idx], t2) - self._at(s[0], s[idx], t1)

    def cores(self, key, t1, t2):
        u = self.usec(key, t1, t2)
        return None if u is None else u / 1e6 / (t2 - t1)

    def keys(self, prefix="misarch-"):
        """Container keys; in an architecture variant also the replica sums (`sum:...`, after the real ones)."""
        real = sorted(k for k in self.series if k.startswith(prefix))
        if prefix == "misarch-" and self.synthetic:
            real += sorted(self.synthetic)
        return real

    def all_cores(self, t1, t2):
        return {k: self.cores(k, t1, t2) for k in self.series}

    def throttled(self, key, t1, t2):
        """(throttled seconds per second, throttled periods per second)."""
        a = self.usec(key, t1, t2, idx=2)
        b = self.usec(key, t1, t2, idx=3)
        if a is None:
            return None, None
        return a / 1e6 / (t2 - t1), b / (t2 - t1)

    def host_cores(self, t1, t2):
        return (self._at(self.host[0], self.host[1], t2) - self._at(self.host[0], self.host[1], t1)) / 1e6 / (t2 - t1)

    def foreign_cores(self, t1, t2):
        """Host CPU not explained by MiSArch containers, the Docker engine or our own tools."""
        h = self.host_cores(t1, t2)
        known = 0.0
        for k in self.series:
            if k.startswith("misarch-") or k.startswith("engine:") or k.startswith("own:"):
                c = self.cores(k, t1, t2)
                if c:
                    known += c
        return h - known

    def foreign_profile(self, t1, t2, step=10):
        out = []
        t = t1
        while t + step <= t2 + 1e-6:
            out.append(round(self.foreign_cores(t, t + step), 3))
            t += step
        return out

    def top_foreign(self, t1, t2):
        return [x for t, x in zip(self.host[0], self.host[3]) if t1 <= t <= t2 and x]

    def swap(self, t1, t2):
        """(swap-in pages/s, swap-out pages/s, major faults/s) between t1 and t2, None if not recorded."""
        if len(self.vm[0]) < 2:
            return None
        r = []
        for i in (1, 2, 3):
            r.append(round((self._at(self.vm[0], self.vm[i], t2) - self._at(self.vm[0], self.vm[i], t1)) / (t2 - t1), 2))
        return tuple(r)

    def steal_cores(self, t1, t2):
        """Hypervisor steal time (cores) between t1 and t2, None if not recorded."""
        if len(self.steal[0]) < 2:
            return None
        return (self._at(*self.steal, t2) - self._at(*self.steal, t1)) / 1e6 / (t2 - t1)

    def load1(self, t1, t2):
        v = [x for t, x in zip(self.host[0], self.host[2]) if t1 <= t <= t2]
        return (min(v), max(v)) if v else (None, None)


ROLE_ORDER = ["app", "dapr", "expsidecar", "db", "gateway", "broker", "keycloak", "other"]
DOMAIN = ["address", "catalog", "discount", "inventory", "invoice", "media", "notification", "order", "payment",
          "return", "review", "shipment", "shoppingcart", "tax", "user", "wishlist"]


def classify(name):
    """container name -> (service, role). Architecture variant (MISARCH_ARCH): from the topology; a deployable's app
    container -> (deployable, app), sidecars -> (their app-id, dapr|expsidecar), a shared DB server -> (server, db);
    replica sums `sum:...` get the role + 'Sum' (excluded from the per-role totals, which count the replicas)."""
    if TOPOLOGY:
        agg = name.startswith(AGG)
        n = name[len(AGG):] if agg else name
        c = n[len(PREFIX):-2] if n.startswith(PREFIX) and n.endswith("-1") else None
        e = TOPOLOGY["containers"].get(c) if c else None
        if agg:
            svc, role = classify_plain(n)
            if c in TOPOLOGY["aggregates"]:
                parts = TOPOLOGY["aggregates"][c]
                e0 = TOPOLOGY["containers"][parts[0]]
                svc = e0.get("unit") if e0["role"] == "app" else e0.get("appId", svc)
                role = {"app": "app", "dapr": "dapr", "ecs": "expsidecar"}.get(e0["role"], role)
            return svc, role + "Sum"
        if e and e["role"] == "app":
            return e["unit"], "app"
        if e and e["role"] in ("dapr", "ecs"):
            return e["appId"], "dapr" if e["role"] == "dapr" else "expsidecar"
        if e and e["role"] == "db":
            return c[:-3] if c.endswith("-db") else c, "db"
    return classify_plain(name)


def classify_plain(name):
    n = short(name)   # strips 'misarch-' or 'misarch-kotlin-' and the replica suffix
    if n == "dapr-redis":
        return "redis", "broker"
    if n in ("placement", "otel-collector", "zipkin-all-in-one", "inventory-mongosetup"):
        return n, "other"
    if n == "simulation-rabbitmq":
        return "simulation", "other"
    for suffix, role in (("-dapr", "dapr"), ("-ecs", "expsidecar"), ("-db", "db"), ("-minio", "db")):
        if n.endswith(suffix):
            svc = n[: -len(suffix)]
            if svc == "keycloak" and role == "db":
                return "keycloak", "keycloak"
            return svc, role
    if n == "gateway":
        return "gateway", "gateway"
    if n == "keycloak":
        return "keycloak", "keycloak"
    if n in DOMAIN:
        return n, "app"
    if n in ("simulation", "experiment-config"):
        return n, "other"
    return n, "other"

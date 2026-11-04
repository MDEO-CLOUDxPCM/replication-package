#!/usr/bin/env python3
"""Session load generator: executes workload/sessions.json (the model the simulation uses) against MiSArch.

- Open session arrivals: per session class a Poisson stream; its rate per phase comes from the workload's mix and
  volume (gen_sessions.workload_rates, the same computation as the PCM usage model and SimOxide's load profile).
  Admin sessions run at their constant rate.
- Within a session the user waits for each response, then thinks (closed loop). A session's path (loops, branches,
  think times, the order's cardinalities) is drawn at its start; the user is then chosen to fit the path (a tracked
  order for orderTracking/createReturn, a wishlist, a credit card for a CREDIT_CARD order). Requests run through
  timing/requests/ext.py's executors with the session's actor: createOrder orders the session's own cart lines,
  placeOrder places that order, createReturn returns the tracked order's items.
- One active cart session per user (sessions with createShoppingcartItem/createOrder/placeOrder): a cart session
  gets a user without another active cart session whenever one fits; read-only sessions may share users. When
  all fitting users are busy (top levels: ~600-900 concurrent cart sessions vs 200 seeded buyers), the least busy
  one is used, and ext.py's cart guard keeps two live sessions of one user from ever holding the same cart line
  (the cause of createOrder's "not in cart"). meta.json: sessions.userSharing (cart sessions on a busy user,
  variant swaps by the guard).
- Anonymous steps (browser class, pages before the login) send the anonymous variants products.anon / product.anon.

    sessiongen.py run --profile day|steady --out DIR [--scale 0.05] [--duration S] [--workload realistic|round2]
    sessiongen.py run --levels 0.25,0.5,1,1.25 [--mix shopping --trans 40 --steady 150] --out DIR
    sessiongen.py plan --profile day --out-plan P.json [...]     write the plan only (for run.py measure)
    sessiongen.py check DIR                                      realised mix vs the model
    sessiongen.py dry --profile steady --sessions 20000          sample paths offline, compare with the model

Plan format ("kind": "sessions"; run.py measure dispatches such plans here):
    {"name", "kind": "sessions", "workload": "realistic"|"round2", "scale": 1.0, "sessions": null, "admin": true,
     "tail": 90, "phases": [{"name", "duration", "volume", "mix"}]}
Output in DIR: requests.csv (loadgen's columns), sessions.csv (one row per session), meta.json (phases, class rates,
summary, scheduler lag, generator CPU).
"""
import argparse
import asyncio
import collections
import csv
import json
import math
import os
import random
import re
import resource
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # the case's root (cases/misarch)
sys.path.insert(0, os.path.join(HERE, "requests"))
sys.path.insert(0, os.path.join(ROOT, "generator"))   # gen_sessions (the case's calibration of core/generator/sessions.py)
import gen_sessions as GS  # noqa: E402

MODEL = GS.load_model()
ADMIN_CLASSES = {"admin", "gatlingAdmin"}
CART_STEPS = {"createShoppingcartItem", "createOrder", "placeOrder"}


# ---------------------------------------------------------------------------------------------- distributions
def sample(spec, rng):
    s = str(spec).replace(" ", "")
    m = re.fullmatch(r"IntPMF\[(.*)\]", s)
    if m:
        pairs = [(int(v), float(p)) for v, p in re.findall(r"\((-?\d+);([\d.eE-]+)\)", m.group(1))]
        return rng.choices([v for v, _ in pairs], [p for _, p in pairs])[0]
    m = re.fullmatch(r"EnumPMF\[(.*)\]", s)
    if m:
        pairs = [(v, float(p)) for v, p in re.findall(r'\(\\?"([^"\\]+)\\?";([\d.eE-]+)\)', m.group(1))]
        return rng.choices([v for v, _ in pairs], [p for _, p in pairs])[0]
    m = re.fullmatch(r"UniDouble\(([\d.]+),([\d.]+)\)", s)
    if m:
        return rng.uniform(float(m.group(1)), float(m.group(2)))
    m = re.fullmatch(r"Exp\(([\d.eE-]+)\)", s)
    if m:
        return rng.expovariate(float(m.group(1)))
    return float(s) if "." in s else int(s)


def expand(steps, rng, args=None, over=None, out=None):
    """One random run of `steps` -> [("call", key, params) | ("think", seconds)]."""
    out = [] if out is None else out
    args, over = args or {}, over or {}
    for st in steps:
        if "call" in st:
            params = {}
            for k, v in (st.get("params") or {}).items():
                if isinstance(v, str) and v.startswith("${"):
                    params[k] = args[v[2:-1]]
                elif isinstance(v, str) and v.startswith("@"):
                    name = v[1:]
                    params[k] = over[name] if name in over else sample(MODEL["cardinalities"][name]["value"], rng)
                else:
                    params[k] = v
            out.append(("call", st["call"], params))
        elif "think" in st:
            out.append(("think", sample(MODEL["think"][st["think"]]["dist"], rng)))
        elif "delay" in st:
            out.append(("think", sample(st["delay"], rng)))
        elif "use" in st:
            fr = MODEL["fragments"][st["use"]]
            a2 = dict(args)
            a2.update({k: (args[v[2:-1]] if isinstance(v, str) and v.startswith("${") else v)
                       for k, v in (st.get("args") or {}).items()})
            o2 = dict(over)
            o2.update(st.get("with") or {})
            expand(fr["steps"], rng, a2, o2, out)
        elif "loop" in st:
            for _ in range(sample(st["loop"], rng)):
                expand(st["body"], rng, args, over, out)
        elif "branch" in st:
            br = st["branch"]
            b = rng.choices(br, [x["p"] for x in br])[0]
            expand(b["body"], rng, args, over, out)
        else:
            raise ValueError(st)
    return out


# ---------------------------------------------------------------------------------------------- plan
def class_rates(workload, mix, volume, sessions=None, scale=1.0, admin=True):
    msa_ops, _ = _msa()
    r = GS.workload_rates(MODEL, msa_ops, workload, mix=mix, volume=volume, sessions=sessions)
    out = {}
    for c, v in r["classes"].items():
        if c in ADMIN_CLASSES:
            if admin:
                out[c] = v * (scale if workload == "round2" else 1.0)
        else:
            out[c] = v * scale
    return out, r["design"]


_MSA = None


def _msa():
    global _MSA
    if _MSA is None:
        _MSA = GS.load_msa()
    return _MSA


def make_plan(a):
    wl = a.workload
    phases = []
    if a.levels:
        for lv in [float(x) for x in a.levels.split(",")]:
            for nm, d in (("trans", a.trans), ("steady", a.steady)):
                phases.append({"name": f"L{lv:g}:{nm}", "duration": d, "volume": lv, "mix": a.mix})
        name = f"sessions-levels-{a.mix}"
    else:
        prof = MODEL["profiles"][a.profile]
        ph = prof["phases"]
        for k, p in enumerate(ph):
            end = ph[k + 1]["from"] if k + 1 < len(ph) else prof["endSeconds"]
            phases.append({"name": p["name"], "duration": end - p["from"], "volume": p["volume"],
                           "mix": p["mix"] if wl == "realistic" else None})
        name = f"sessions-{a.profile}"
    if a.duration:          # truncate (functional checks)
        left, cut = a.duration, []
        for p in phases:
            if left <= 0:
                break
            cut.append(dict(p, duration=min(p["duration"], left)))
            left -= p["duration"]
        phases = cut
    plan = {"name": name + (f"-x{a.scale:g}" if a.scale != 1 else ""), "kind": "sessions", "workload": wl,
            "scale": a.scale, "sessions": a.sessions, "admin": not a.no_admin, "tail": a.tail, "phases": phases}
    for p in plan["phases"]:
        p["classRates"] = {c: round(v, 5) for c, v in class_rates(wl, p.get("mix"), p["volume"], a.sessions, a.scale,
                                                                   not a.no_admin)[0].items()}
    return plan


# ---------------------------------------------------------------------------------------------- execution
class Runner:
    def __init__(self, g, plan, seed, sess_w):
        import ext as X
        self.X = X
        self.g, self.plan, self.sw = g, plan, sess_w
        self.rng = random.Random(seed + 1)
        self.n = 0
        self.stats = collections.defaultdict(lambda: collections.Counter())
        self.lag = []
        self.tasks = set()
        self.buyers = g.buyers[:plan["maxUsers"]] if plan.get("maxUsers") else g.buyers   # --max-users: checks only
        self.with_cc = [b for b in self.buyers if any(p["paymentMethod"] == "CREDIT_CARD" for p in b["paymentInformations"])]
        self.with_cc_set = {id(b) for b in self.with_cc}
        self.with_wl = [b for b in self.buyers if g.wishlists_of(b)]
        self.active = collections.Counter()      # username -> active cart sessions
        self.sharing = collections.Counter()     # cart sessions started on a user with another active cart session
        self.max_active = collections.Counter()

    def choose(self, cls, path):
        g, rng, X = self.g, self.rng, self.X
        calls = [x[1] for x in path if x[0] == "call"]
        a = X.Actor(cls=cls)
        if cls in ADMIN_CLASSES:
            a.user = g.st["admin"]
            if "login" not in calls:          # gatlingAdmin: no login step (round 2), the cached admin token
                a.token = g.admin_tok
            return a
        if "login" not in calls:
            return a                          # anonymous (browser)
        co = next((x[2] for x in path if x[0] == "call" and x[1] == "createOrder"), {})
        a.method = co.get("paymentMethod.VALUE")
        a.coupons = int(co.get("coupons.NUMBER_OF_ELEMENTS", 0))
        q = co.get("quantity.VALUE")
        if q is None:
            q = sample(MODEL["cardinalities"]["quantityPerItem"]["value"], rng) if cls != "gatling" else 1
        a.qty = lambda q=int(q): q
        wl = bool({"wishlistView", "addToWishlist"} & set(calls))
        cc = a.method == "CREDIT_CARD"
        cart = bool(CART_STEPS & set(calls))

        def fits(b, free=True):
            return (not wl or g.wishlists_of(b)) and (not cc or id(b) in self.with_cc_set) and \
                (not (cart and free) or self.active[b["username"]] == 0)
        if "return.createReturn" in calls:
            while g.returnable and g.returnable[0][1] in g.returned:
                g.returnable.pop(0)
            k = next((i for i, x in enumerate(g.returnable[:50]) if x[0] in g.by_name and fits(g.by_name[x[0]])), 0)
            if g.returnable:
                u, oid, items = g.returnable.pop(k)
                a.user, a.track_oid = g.by_name[u], oid
                return a
        if "orderTracking" in calls and g.placed:
            for _ in range(50):
                u, oid = rng.choice(g.placed[-2000:])
                if u in g.by_name and fits(g.by_name[u]):
                    a.user, a.track_oid = g.by_name[u], oid
                    return a
        pool = self.with_wl if wl else self.with_cc if cc else self.buyers
        cands = [b for b in pool if fits(b)]
        if cands:
            a.user = rng.choice(cands)
        else:                                 # every fitting user has an active cart session: the least busy one
            cands = [b for b in pool if fits(b, free=False)] or self.buyers
            least = min(self.active[b["username"]] for b in cands)
            a.user = rng.choice([b for b in cands if self.active[b["username"]] == least])
            self.sharing["sharedUser"] += 1
        return a

    async def session(self, cls, t_arr):
        g, L = self.g, self.X.L
        self.n += 1
        sid = self.n
        path = expand(MODEL["classes"][cls]["steps"], self.rng)
        a = self.choose(cls, path)
        cart = a.user is not None and cls not in ADMIN_CLASSES and bool(CART_STEPS & {x[1] for x in path if x[0] == "call"})
        if cart:
            self.active[a.user["username"]] += 1
            self.max_active[a.user["username"]] = max(self.max_active[a.user["username"]], self.active[a.user["username"]])
        st = self.stats[cls]
        st["started"] += 1
        done = collections.Counter()
        status = "ok"
        t0 = time.time()
        try:
            for step in path:
                if step[0] == "think":
                    await asyncio.sleep(step[1])
                    continue
                key = step[1]
                if key in ("products", "product") and a.token is None:
                    key_rec = key + ".anon"
                else:
                    key_rec = key
                try:
                    ok = await g.run_session_call(key, a, time.time())
                except L.Skip:
                    g.skipped[key_rec] = g.skipped.get(key_rec, 0) + 1
                    ok = None
                except Exception as e:  # generator error: recorded like loadgen's safe_do
                    g.w.writerow([key_rec, g.phase, f"{time.time() - g.t0:.4f}", "", "", "", -1, 0, 0,
                                  f"generator error {type(e).__name__}: {e}"[:200]])
                    ok = False
                done[key_rec] += 1
                if not ok:
                    st["failedRequests"] += 1
                    if key == "login":
                        status = "loginFailed"
                        break
            st["completed" if status == "ok" else "aborted"] += 1
        except asyncio.CancelledError:
            status = "cancelled"
            st["cancelled"] += 1
        finally:
            if cart:
                self.active[a.user["username"]] -= 1
                self.X.release_cart(g, a)
        self.sw.writerow([sid, cls, f"{t_arr - g.t0:.3f}", f"{t0 - g.t0:.3f}", f"{time.time() - g.t0:.3f}", status,
                          a.user["username"] if a.user else "", json.dumps(dict(done), separators=(",", ":"))])

    async def arrivals(self, cls, rate, t_start, t_end):
        rng = random.Random(self.rng.random())
        t = t_start
        while True:
            t += rng.expovariate(rate)
            if t >= t_end:
                return
            now = time.time()
            if t > now:
                await asyncio.sleep(t - now)
            self.lag.append(time.time() - t)
            tk = asyncio.create_task(self.session(cls, t))
            self.tasks.add(tk)
            tk.add_done_callback(self.tasks.discard)


class RowWriter:
    def __init__(self, path, header):
        self.f = open(path, "w", newline="")
        self.w = csv.writer(self.f)
        self.w.writerow(header)

    def writerow(self, r):
        self.w.writerow(r)

    def close(self):
        self.f.close()


async def run_plan(plan, out_dir, seed):
    import aiohttp
    import ext as X
    L = X.L
    X.install()
    os.makedirs(out_dir, exist_ok=True)
    state = json.load(open(L.STATE))
    w = L.BackgroundCsvWriter(os.path.join(out_dir, "requests.csv"),
                              ["type", "phase", "t_sched", "t_send", "epoch_send", "latency_ms", "http", "ok",
                               "n_errors", "error"])
    sw = RowWriter(os.path.join(out_dir, "sessions.csv"), ["sid", "class", "t_arrival", "t_start", "t_end", "status",
                                                           "user", "requests"])
    meta = {"plan": plan, "seed": seed, "gateway": L.GATEWAY, "phases": []}
    for p in plan["phases"]:
        if "classRates" not in p:
            p["classRates"] = class_rates(plan.get("workload", "realistic"), p.get("mix"), p["volume"],
                                          plan.get("sessions"), plan.get("scale", 1.0), plan.get("admin", True))[0]
    conn = aiohttp.TCPConnector(limit=4000, limit_per_host=4000, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=60)) as s:
        t0 = time.time()
        g = X.ExtGen(state, seed, w, t0)
        g.http = s
        dur = sum(p["duration"] for p in plan["phases"]) + plan.get("tail", 90)
        meta["tokens_fetched"] = await g.prefetch_tokens(s, min_valid_s=max(1500, dur + 120))
        run = Runner(g, plan, seed, sw)
        ru0 = resource.getrusage(resource.RUSAGE_SELF)       # generator CPU from here on (startup excluded)
        g.t0 = t0 = time.time()
        meta["t0"] = t0
        t = t0
        for i, ph in enumerate(plan["phases"]):
            while h := L.clear_hold(ph, t):
                t = await L.hold(g, s, meta, ph, t, h, sum(p["duration"] for p in plan["phases"][i:]), classRates={})
            g.phase = ph["name"]
            t_end = t + ph["duration"]
            meta["phases"].append({"name": ph["name"], "start": t, "end": t_end, "classRates": ph["classRates"]})
            print(f"[{time.strftime('%H:%M:%S')}] phase {ph['name']} {ph['duration']}s sessions/s="
                  f"{sum(ph['classRates'].values()):.2f} {ph['classRates']}", flush=True)
            await asyncio.gather(*(run.arrivals(c, r, t, t_end) for c, r in ph["classRates"].items() if r > 0))
            now = time.time()
            if t_end > now:
                await asyncio.sleep(t_end - now)
            t = t_end
        g.phase = "tail"
        meta["t_arrivals_end"] = time.time()
        if run.tasks:
            _, pending = await asyncio.wait(set(run.tasks), timeout=plan.get("tail", 90))
            for tk in pending:
                tk.cancel()
            if pending:
                await asyncio.wait(pending, timeout=10)
        meta["t_end"] = time.time()
    g.save_pools()
    w.close()
    sw.close()
    ru1 = resource.getrusage(resource.RUSAGE_SELF)
    cpu = (ru1.ru_utime - ru0.ru_utime) + (ru1.ru_stime - ru0.ru_stime)
    lag = sorted(run.lag)
    nreq = sum(1 for _ in open(os.path.join(out_dir, "requests.csv"))) - 1
    meta["generatorCpuS"] = round(cpu, 2)
    meta["generatorCpuMsPerRequest"] = round(1000 * cpu / max(1, nreq), 3)
    meta["generatorCores"] = round(cpu / max(1e-9, meta["t_end"] - meta["t0"]), 3)
    meta["scheduler_lag_ms"] = {"n": len(lag), "mean": round(1000 * sum(lag) / len(lag), 2) if lag else None,
                                "p99": round(1000 * lag[int(0.99 * (len(lag) - 1))], 2) if lag else None,
                                "max": round(1000 * lag[-1], 2) if lag else None}
    meta["max_inflight"] = g.max_inflight
    meta["skipped"] = g.skipped
    meta["sessions"] = {c: dict(v) for c, v in run.stats.items()}
    meta["sessions"]["userSharing"] = dict(run.sharing, cartVariantSwaps=g.__dict__.get("cart_swaps", 0),
                                           maxActiveCartSessionsPerUser=max(run.max_active.values(), default=0))
    meta["summary"] = L.summarize(os.path.join(out_dir, "requests.csv"))
    json.dump(meta, open(os.path.join(out_dir, "meta.json"), "w"), indent=1)
    return meta


# ---------------------------------------------------------------------------------------------- checks
def base_type(t):
    return t[:-5] if t.endswith(".anon") else t


def check(out_dir, quiet=False):
    """Realised requests per session per class vs the model's expectation; overall mix vs the model."""
    meta = json.load(open(os.path.join(out_dir, "meta.json")))
    rows = list(csv.DictReader(open(os.path.join(out_dir, "sessions.csv"))))
    per = collections.defaultdict(collections.Counter)
    nses = collections.Counter()
    for r in rows:
        if r["status"] == "cancelled":
            continue
        nses[r["class"]] += 1
        for k, v in json.loads(r["requests"]).items():
            per[r["class"]][base_type(k)] += v
    lines, worst = [], 0.0
    exp_tot, got_tot = collections.Counter(), collections.Counter()
    for c, n in sorted(nses.items()):
        st = GS.class_stats(MODEL, c)
        exp = st["visits"]
        lines.append(f"{c}: {n} sessions, requests/session {sum(per[c].values()) / n:.2f} "
                     f"(model {sum(exp.values()):.2f})")
        for k in sorted(set(exp) | set(per[c])):
            e = exp.get(k, 0.0) * n
            gq = per[c][k]
            exp_tot[k] += e
            got_tot[k] += gq
            z = (gq - e) / math.sqrt(max(e, 1.0))
            worst = max(worst, abs(z)) if e >= 5 else worst
            lines.append(f"    {k:44s} got {gq:6d}  expected {e:8.1f}  z {z:+5.1f}")
    tot_e, tot_g = sum(exp_tot.values()), sum(got_tot.values())
    lines.append("overall mix (share of requests): type, got, model (given the realised sessions)")
    for k in sorted(exp_tot, key=lambda x: -exp_tot[x]):
        lines.append(f"    {k:44s} {got_tot[k] / max(1, tot_g):7.4f} {exp_tot[k] / max(1e-9, tot_e):7.4f}")
    errs = sum(d["n"] - d["ok"] for ph in meta["summary"].values() for d in ph.values())
    nreq = sum(d["n"] for ph in meta["summary"].values() for d in ph.values())
    lines.append(f"requests {nreq}, errors {errs}, skipped {meta.get('skipped')}, sessions {dict(meta['sessions'])}")
    lines.append(f"generator {meta.get('generatorCores')} cores, {meta.get('generatorCpuMsPerRequest')} ms CPU per request, "
                 f"scheduler lag {meta.get('scheduler_lag_ms')}")
    lines.append(f"max |z| over types with >= 5 expected: {worst:.1f}")
    res = "\n".join(lines)
    if not quiet:
        print(res)
    return res


def dry(a):
    """Offline: sample paths, compare visits per class with gen_sessions' expectation (no stack needed)."""
    rng = random.Random(1)
    for c in MODEL["classes"]:
        n = a.sessions
        cnt, think = collections.Counter(), 0.0
        for _ in range(n):
            for x in expand(MODEL["classes"][c]["steps"], rng):
                if x[0] == "call":
                    cnt[x[1]] += 1
                else:
                    think += x[1]
        exp = GS.class_stats(MODEL, c)
        bad = [k for k in set(exp["visits"]) | set(cnt)
               if abs(cnt[k] / n - exp["visits"].get(k, 0)) > 4 * math.sqrt(max(exp["visits"].get(k, 0), 1e-4) / n) + 1e-3]
        print(f"{c:14s} req/session {sum(cnt.values()) / n:6.2f} (model {sum(exp['visits'].values()):6.2f})  "
              f"think {think / n:5.1f} s (model {exp['think']:5.1f})  deviating: {bad or 'none'}")
    for ph in (MODEL["profiles"][a.profile]["phases"]):
        r, d = class_rates("realistic", ph["mix"], ph["volume"])
        print(f"{ph['name']:10s} design {d:.1f} sessions/s: " + ", ".join(f"{c} {v:.2f}" for c, v in r.items()))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "plan"):
        p = sp.add_parser(name)
        p.add_argument("--profile", default="steady", choices=list(MODEL["profiles"]))
        p.add_argument("--levels")
        p.add_argument("--mix", default="shopping")
        p.add_argument("--trans", type=float, default=40)
        p.add_argument("--steady", type=float, default=150)
        p.add_argument("--workload", default="realistic", choices=["realistic", "round2"])
        p.add_argument("--sessions", type=float, default=None, help="design sessions/s (default: the model's)")
        p.add_argument("--scale", type=float, default=1.0, help="multiplies the customer session rates")
        p.add_argument("--duration", type=float, default=None, help="truncate the plan (functional checks)")
        p.add_argument("--no-admin", action="store_true")
        p.add_argument("--max-users", type=int, default=None, help="functional checks: only the first N buyers")
        p.add_argument("--tail", type=float, default=90)
        if name == "run":
            p.add_argument("--out", required=True)
            p.add_argument("--seed", type=int, default=int(time.time()))
        else:
            p.add_argument("--out-plan", required=True)
    p = sp.add_parser("check")
    p.add_argument("dir")
    p = sp.add_parser("dry")
    p.add_argument("--sessions", type=int, default=20000)
    p.add_argument("--profile", default="day")
    a = ap.parse_args()
    if a.cmd == "dry":
        return dry(a)
    if a.cmd == "check":
        return check(a.dir)
    plan = make_plan(a)
    if a.max_users:
        plan["maxUsers"] = a.max_users
    if a.cmd == "plan":
        json.dump(plan, open(a.out_plan, "w"), indent=1)
        print(f"{a.out_plan}: {len(plan['phases'])} phases, {sum(p['duration'] for p in plan['phases']):.0f} s")
        return
    meta = asyncio.run(run_plan(plan, a.out, a.seed))
    open(os.path.join(a.out, "check.txt"), "w").write(check(a.out, quiet=True))
    print(check(a.out, quiet=True))
    print("generator cores", meta["generatorCores"], "lag", meta["scheduler_lag_ms"])


if __name__ == "__main__":
    main()

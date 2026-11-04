#!/usr/bin/env python3
"""Stack-side helpers of the timing harness (README.md §2.3, §9): pg_stat_statements and async-profiler per
container, data volume. Used by timing-up.sh (ext, reset, status) and by window.py (per-segment hooks).

    stackctl.py apps | dbs                  running app / Postgres containers of misarch-kotlin
    stackctl.py ext                         CREATE EXTENSION pg_stat_statements in every database of every Postgres
    stackctl.py reset                       pg_stat_statements_reset() on every Postgres
    stackctl.py dump OUT.json               pg_stat_statements of every Postgres (all databases)
    stackctl.py volume OUT.json             data volume: database sizes and live rows per table
    stackctl.py asprof-start [--interval 10ms]
    stackctl.py asprof-stop DIR_IN_CONTAINER PREFIX   folded output to /timing/<DIR>/<PREFIX>__<app>.collapsed
    stackctl.py status                      mode of the running stack (override on/off, sampler, preload)
    stackctl.py cache-counts                block 6: entity cache counters of catalog and shipment (GET
                                            /mechanisms/entity-cache on the app port; no tracing needed)
    stackctl.py counters                    GET /timing/counters of every app (cumulative statement and
                                            operation CPU counters of the timing build, README.md §2.2)
    stackctl.py starts                      StartedAt and restart count of every app container (JVM lifetime)

Containers are found by name prefix (misarch-kotlin-) and image: apps = misarch-kotlin/*, Postgres = postgres:16
(Keycloak's postgres:16-alpine is not part of the timing). Calls run in parallel threads; `docker exec` only.
"""
import argparse
import concurrent.futures as cf
import json
import subprocess
import sys
import time

PREFIX = "misarch-kotlin-"
ASPROF = "/opt/async-profiler/bin/asprof"
# own statements of the harness, excluded from dumps
OWN = ("pg_stat_statements", "pg_database", "pg_stat_user_tables", "pg_database_size")


def sh(args, input=None, timeout=60):
    r = subprocess.run(args, capture_output=True, text=True, input=input, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def running():
    rc, out, _ = sh(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}"])
    res = []
    for line in out.splitlines():
        n, img = line.split("\t")
        if n.startswith(PREFIX):
            res.append((n, img))
    return res


def apps():
    return sorted(n for n, img in running() if img.startswith("misarch-kotlin/"))


def dbs():
    return sorted(n for n, img in running() if img == "postgres:16")


def short(c):
    """misarch-kotlin-order-db-1 -> order-db"""
    n = c[len(PREFIX):] if c.startswith(PREFIX) else c
    return n[:-2] if n.endswith("-1") else n


def pmap(fn, items, workers=20):
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        return dict(zip(items, ex.map(fn, items)))


def psql(c, sql, db="postgres", timeout=60):
    return sh(["docker", "exec", "-i", c, "psql", "-q", "-At", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1"],
              input=sql, timeout=timeout)


def databases(c):
    rc, out, err = psql(c, "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres';")
    if rc:
        raise RuntimeError(f"{c}: {err.strip()}")
    return [x for x in out.split() if x]


def ext_one(c):
    res = {}
    for db in ["postgres"] + databases(c):
        rc, out, err = psql(c, "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;", db)
        res[db] = "ok" if rc == 0 else err.strip()[-200:]
    return res


def ext():
    return pmap(ext_one, dbs())


def reset_one(c):
    rc, out, err = psql(c, "SELECT pg_stat_statements_reset();")
    return {"t": time.time(), "ok": rc == 0, "err": err.strip()[-200:] if rc else None}


def reset():
    return pmap(reset_one, dbs())


DUMP_SQL = """SELECT coalesce(json_agg(x), '[]') FROM (
  SELECT d.datname, s.* FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
  WHERE s.query NOT ILIKE '%pg_stat_statements%' AND s.query NOT ILIKE '%pg_database%'
    AND s.query NOT ILIKE '%pg_stat_user_tables%') x;"""


def dump_one(c):
    t = time.time()
    rc, out, err = psql(c, DUMP_SQL)
    if rc:
        return {"t": t, "error": err.strip()[-300:], "rows": []}
    return {"t": t, "rows": json.loads(out.strip() or "[]")}


def dump():
    return pmap(dump_one, dbs())


XACT_SQL = """SELECT json_build_object('t', extract(epoch from now()),
  'wal', (SELECT json_build_object('records', wal_records, 'bytes', wal_bytes, 'write', wal_write, 'sync', wal_sync)
          FROM pg_stat_wal),
  'dbs', (SELECT json_object_agg(datname, json_build_object('commit', xact_commit, 'rollback', xact_rollback))
          FROM pg_stat_database WHERE datname IS NOT NULL));"""


def xact_one(c):
    """Transaction and WAL counters of one Postgres (commits per request; pg_stat_statements has no
    BEGIN/COMMIT rows). Cumulative; window.py takes the deltas per steady segment."""
    rc, out, err = psql(c, XACT_SQL)
    return json.loads(out) if rc == 0 and out.strip() else {"error": err.strip()[-200:]}


def xact():
    return pmap(xact_one, dbs())


VOL_SQL = """SELECT json_build_object('size', pg_database_size(current_database()), 'tables',
  (SELECT coalesce(json_object_agg(relname, n_live_tup), '{}') FROM pg_stat_user_tables));"""


def volume_one(c):
    res = {}
    for db in databases(c):
        rc, out, err = psql(c, VOL_SQL, db)
        res[db] = json.loads(out) if rc == 0 else {"error": err.strip()[-200:]}
    return res


def volume():
    return {"t": time.time(), "dbs": pmap(volume_one, dbs())}


def asprof_start_one(c, interval="10ms"):
    t = time.time()
    rc, out, err = sh(["docker", "exec", c, ASPROF, "start", "-e", "itimer", "-i", interval, "1"])
    return {"t": t, "ok": rc == 0, "msg": (out + err).strip()[-200:]}


def asprof_start(interval="10ms", containers=None):
    return pmap(lambda c: asprof_start_one(c, interval), containers or apps())


def asprof_stop_one(c, path):
    t = time.time()
    rc, out, err = sh(["docker", "exec", c, ASPROF, "stop", "-o", "collapsed", "-f", path, "1"], timeout=120)
    return {"t": t, "ok": rc == 0, "file": path, "msg": (out + err).strip()[-200:]}


def asprof_stop(subdir, prefix, containers=None):
    """subdir: directory below /timing (created by the caller on the host, mode 777)."""
    return pmap(lambda c: asprof_stop_one(c, f"/timing/{subdir}/{prefix}__{short(c)}.collapsed"),
                containers or apps())


CACHE_APPS = ("catalog", "shipment", "order")
CACHE_ROUTE = {"order": "/mechanisms/caller-cache"}     # order: caller-side cache (README.md §4.1)


def cache_counts_one(c):
    import urllib.request
    t = time.time()
    rc, out, err = sh(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", c])
    ip = (out.split() or [""])[0]
    route = CACHE_ROUTE.get(short(c), "/mechanisms/entity-cache")
    try:
        with urllib.request.urlopen(f"http://{ip}:8080{route}", timeout=5) as r:
            return dict(json.loads(r.read()), t=t)
    except Exception as e:     # cache off: no such route (404)
        return {"t": t, "error": f"{type(e).__name__}: {e}"[:120]}


def cache_counts():
    return pmap(cache_counts_one, [f"{PREFIX}{a}-1" for a in CACHE_APPS])


def _app_ip(c):
    rc, out, err = sh(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", c])
    return (out.split() or [""])[0]


def counters_one(c):
    """GET /timing/counters (README.md §2.2): {"enabled", "t" (ms), "statements": [{key, sql, entity, mode, calls, rows,
    driverCpuNs, mappingCpuNs}], "operations": [{key, kind, calls, cpuNs}], "threadCpuNsTotal"} (cumulative)."""
    import urllib.request
    t = time.time()
    try:
        with urllib.request.urlopen(f"http://{_app_ip(c)}:8080/timing/counters", timeout=10) as r:
            return dict(json.loads(r.read()), tHarness=t)
    except Exception as e:     # counters off or an image without them: 404
        return {"tHarness": t, "error": f"{type(e).__name__}: {e}"[:120]}


def counters(containers=None):
    return pmap(counters_one, containers or apps())


def counter_delta(v0, v1):
    """Difference of two cumulative /timing/counters snapshots of one app. Keys present only in v1 count from 0; a
    counter that went down (app restarted) makes the delta `reset: true` with v1's values."""
    reset = v1.get("threadCpuNsTotal", 0) < v0.get("threadCpuNsTotal", 0)
    base = {} if reset else v0

    def by_key(snap, field):
        return {x["key"]: x for x in (snap.get(field) or [])}
    st0, op0 = by_key(base, "statements"), by_key(base, "operations")
    stm, ops = {}, {}
    for k, x in by_key(v1, "statements").items():
        x0 = st0.get(k, {})
        d = {f: x.get(f, 0) - x0.get(f, 0) for f in ("calls", "rows", "driverCpuNs", "mappingCpuNs")}
        if d["calls"] > 0:
            stm[k] = dict(d, sql=x.get("sql"), entity=x.get("entity"), mode=x.get("mode"))
    for k, x in by_key(v1, "operations").items():
        x0 = op0.get(k, {})
        d = {f: x.get(f, 0) - x0.get(f, 0) for f in ("calls", "cpuNs")}
        if d["calls"] > 0:
            ops[k] = dict(d, kind=x.get("kind"))
    return {"seconds": round(((v1.get("t") or 0) - (v0.get("t") or 0)) / 1000, 3), "reset": reset,
            "threadCpuNs": v1.get("threadCpuNsTotal", 0) - base.get("threadCpuNsTotal", 0),
            "statements": stm, "operations": ops}


def starts(containers=None):
    """{app container: "StartedAt RestartCount"}: a JVM whose value changed was restarted (cold JIT)."""
    cs = containers or apps()
    if not cs:
        return {}
    rc, out, _ = sh(["docker", "inspect", "-f", "{{.Name}} {{.State.StartedAt}} {{.RestartCount}}"] + cs)
    res = {}
    for line in out.splitlines():
        n, s, r = line.split()
        res[n.lstrip("/")] = f"{s} {r}"
    return res


def status():
    res = {"apps": len(apps()), "dbs": len(dbs())}
    a = apps()
    if a:
        rc, out, _ = sh(["docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", a[0]])
        env = dict(x.split("=", 1) for x in out.splitlines() if "=" in x)
        res["app0"] = a[0]
        res["traces"] = env.get("OTEL_TRACES_EXPORTER")
        res["sampler"] = env.get("OTEL_TRACES_SAMPLER_ARG")
        res["timingSpans"] = env.get("MISARCH_TIMING_SPANS")
        rc, out, _ = sh(["docker", "inspect", "-f", "{{.Config.Image}}", a[0]])
        res["image0"] = out.strip()
    d = dbs()
    if d:
        rc, out, _ = psql(d[0], "SHOW shared_preload_libraries;")
        res["preload"] = out.strip()
    sides = [n for n, _ in running() if n.endswith("-dapr-1")]
    if sides:
        rc, out, _ = sh(["docker", "inspect", "-f", "{{range .Mounts}}{{.Source}} {{end}}", sides[0]])
        res["daprTracing"] = "dapr-config.yaml" in out
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["apps", "dbs", "ext", "reset", "dump", "volume", "asprof-start", "asprof-stop",
                                    "status", "cache-counts", "counters", "starts"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--interval", default="10ms")
    a = ap.parse_args()
    if a.cmd == "apps":
        print("\n".join(apps()))
    elif a.cmd == "dbs":
        print("\n".join(dbs()))
    elif a.cmd in ("ext", "reset", "status"):
        print(json.dumps({"ext": ext, "reset": reset, "status": status}[a.cmd](), indent=1))
    elif a.cmd in ("dump", "volume"):
        r = dump() if a.cmd == "dump" else volume()
        if a.args:
            json.dump(r, open(a.args[0], "w"))
        else:
            print(json.dumps(r)[:5000])
    elif a.cmd == "cache-counts":
        print(json.dumps(cache_counts(), indent=1))
    elif a.cmd == "counters":
        print(json.dumps(counters(), indent=1)[:20000])
    elif a.cmd == "starts":
        print(json.dumps(starts(), indent=1))
    elif a.cmd == "asprof-start":
        print(json.dumps(asprof_start(a.interval), indent=1))
    elif a.cmd == "asprof-stop":
        print(json.dumps(asprof_stop(a.args[0], a.args[1]), indent=1))


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Measured CPU counters per (request, service) (README.md §2.2; misarch-kotlin timing build).

    counters.py WINDOW [--out WINDOW/analysis/counters.json]

Input: WINDOW/counters.json (window.py --counters): per steady segment and app the deltas of GET /timing/counters,
i.e. per statement shape (key, sql, entity, mode) calls, rows, driverCpuNs, mappingCpuNs; per operation (key, kind =
graphql | entities | dataloader | event | http) calls, cpuNs; threadCpuNsTotal. All CPU is thread CPU of the JVM.

Per (request type, app), per request of the segment (n from requests.csv):
- access CPU = sum over statements of driver + mapping CPU (measured; the alphaRead/alphaWrite/beta fit of the profile's
  persistence CPU stays as the cross-check);
- own CPU per operation = the operation counter's CPU (measured; split_own's entry-frame / span convention is the
  fallback without counters);
- the rest of the app's CPU (cgroup, net of the idle baseline, without the instrumentation share of the profile and
  without the dapr-client middleware) is the per-request overhead of the service: HTTP, GraphQL parse/validate,
  serialisation, GC, JIT: `requestOverhead`, its own part (parts.py).
Coverage check: (access + operations) / app CPU, threadCpu / cgroup CPU, and access vs the profile's db-driver +
mapping buckets (`profileAccessRatio`).
Operation keys (README.md §2.2, misarch-kotlin docs/TIMING-COUNTERS.md) -> A's operations (match_operation): graphql
`Parent.field` = A's trigger, `_entities.<Type>` (several types joined by `+`) = A's `_entities(<Type>)`, event = the
topic (several joined by `|`), http `METHOD route` = A's http trigger; a `dataloader` key (loader class) = the
operations whose entry is a libs/common DataLoaderEntityResolver over it (unify's federation entries); other
dataloader keys and other unmatched keys stay unattributed own CPU (parts.py spreads them like split_own's leftover). http keys that are no A
operation are not own work: `POST /graphql` (engine work outside the fetchers) goes to the request overhead, health
and Dapr probes (`/health`, `/actuator`, `/dapr/`) are background (in the cgroup's idle baseline) and are dropped.
The counters are disjoint (an operation's cpuNs excludes nested operations and the statement CPU inside it) and do
not cover Netty I/O, protocol decode, body encode/decode outside coroutine resumes, WebClient I/O, BEGIN/COMMIT,
GC/JIT or agent threads: coverage is expected well below 100 % (`attributedOfThread`).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

NS_MS = 1e6
BACKGROUND_HTTP = ("/health", "/actuator", "/dapr/", "/mechanisms/", "/timing/")


def op_class(o):
    """'own' (an operation), 'engine' (POST /graphql outside the fetchers: request overhead) or 'background'."""
    if o.get("kind") != "http":
        return "own"
    if any(x in o["key"] for x in BACKGROUND_HTTP):
        return "background"
    return "engine" if "/graphql" in o["key"] else "own"


def per_request(delta, n):
    """One app's counter delta over a segment -> per-request values (ms). n = requests of the segment's type."""
    n = n or 1
    stm = []
    for k, x in (delta.get("statements") or {}).items():
        drv, mp = x.get("driverCpuNs", 0) / NS_MS, x.get("mappingCpuNs", 0) / NS_MS
        stm.append({"key": k, "sql": x.get("sql"), "entity": x.get("entity"), "mode": x.get("mode"),
                    "callsPerReq": x.get("calls", 0) / n, "rowsPerReq": x.get("rows", 0) / n,
                    "driverCpuMs": drv / n, "mappingCpuMs": mp / n,
                    "cpuMsPerCall": (drv + mp) / x["calls"] if x.get("calls") else None})
    ops = [{"key": k, "kind": x.get("kind"), "callsPerReq": x.get("calls", 0) / n, "cpuMs": x.get("cpuNs", 0) / NS_MS / n}
           for k, x in (delta.get("operations") or {}).items()]
    for o in ops:
        o["class"] = op_class(o)
    acc = sum(s["driverCpuMs"] + s["mappingCpuMs"] for s in stm)
    return {"n": n, "accessCpuMs": acc, "operationsCpuMs": sum(o["cpuMs"] for o in ops if o["class"] == "own"),
            "engineCpuMs": sum(o["cpuMs"] for o in ops if o["class"] == "engine"),
            "backgroundCpuMs": sum(o["cpuMs"] for o in ops if o["class"] == "background"),
            "threadCpuMs": delta.get("threadCpuNs", 0) / NS_MS / n, "seconds": delta.get("seconds"),
            "reset": delta.get("reset", False), "statements": stm, "operations": ops}


def shares(pr, d_on, instr_share=0.0, mw_share=0.0):
    """Per-request counter values pr (instrumented run) and the app's cgroup CPU per request in the same segment d_on
    -> shares of the app's CPU without instrumentation: access, per operation, middleware (profile), remainder.
    mw_share is the dapr-client share of the non-instrumentation CPU (profile)."""
    base = d_on * (1 - (instr_share or 0.0))
    if base <= 0:
        return None
    acc = pr["accessCpuMs"] / base
    ops = {o["key"]: o["cpuMs"] / base for o in pr["operations"] if o.get("class", "own") == "own"}
    used = acc + sum(ops.values()) + (mw_share or 0.0)
    attributed = pr["accessCpuMs"] + pr["operationsCpuMs"] + pr.get("engineCpuMs", 0.0)
    return {"access": acc, "operations": ops, "middleware": mw_share or 0.0, "remainder": max(0.0, 1 - used),
            "engine": pr.get("engineCpuMs", 0.0) / base, "coverage": attributed / base, "over": used > 1.0,
            "attributedOfThread": attributed / pr["threadCpuMs"] if pr["threadCpuMs"] > 0 else None,
            "threadCoverage": pr["threadCpuMs"] / d_on if d_on > 0 else None}


def match_operation(key, kind, ops, loaders=None):
    """Counter operation key -> A's operation ids among `ops` ({id: op}); [] when it cannot be told. `loaders`
    ({id: data loader class name}, parts.entry_dataloader): a `dataloader` key goes to the operations whose entry is
    a resolver over that loader (libs/common DataLoaderEntityResolver: the batch is the `_entities` work)."""
    k = key.strip()
    if kind == "dataloader":
        name = k.split()[-1] if k else k
        return [oid for oid in ops if (loaders or {}).get(oid) and (loaders or {}).get(oid) == name]
    if kind == "entities":
        ent = k[len("_entities."):] if k.startswith("_entities.") else (k[len("_entities("):-1] if k.startswith("_entities(") else k)
        want = {f"_entities({t})" for t in ent.split("+")}
        return [oid for oid, o in ops.items() if (o.get("trigger") or {}).get("graphql") in want]
    if kind == "event":
        topics = set(k.split("|"))
        return [oid for oid, o in ops.items() if (o.get("trigger") or {}).get("topic") in topics]
    out = []
    for oid, o in ops.items():
        tr = o.get("trigger") or {}
        g, http = tr.get("graphql", ""), tr.get("http")
        if kind == "graphql" and g and not g.startswith("_entities"):
            if g == k or ("." not in k and g.split(".")[-1] == k and g.split(".")[0] in ("Query", "Mutation")):
                out.append(oid)
        elif kind == "http" and http:
            route = k.split(" ", 1)[-1]
            h = http if isinstance(http, str) else json.dumps(http)
            if route and (route in h or h in k):
                out.append(oid)
    return out


def match_access(stmt, accesses, parse_sql):
    """Counter statement -> index of the pg_stat_statements access (queries.py) with the same mode whose tables hold
    the statement's target table; None if none."""
    if not stmt.get("sql"):
        return None
    p = parse_sql(stmt["sql"])
    if p["kind"] == "tx":
        return None
    tgt = (p["writes"] or p["tables"] or [None])[0]
    mode = stmt.get("mode") or p["kind"]
    for i, a in enumerate(accesses):
        if a["mode"] == mode and tgt in a.get("tables", []):
            return i
    for i, a in enumerate(accesses):
        if tgt in a.get("tables", []):
            return i
    return None


def window_counters(d):
    """WINDOW/counters.json -> {segment: {app: per_request(...)}} with n = requests of the segment's type(s)."""
    d = common.window_dir(d)
    c = common.load_json(d, "counters.json")
    if not c:
        return {}
    segs = common.segments(d)
    meta = common.load_json(d, "meta.json") or {"phases": []}
    rates = {p["name"]: p.get("rates", {}) for p in meta["phases"]}
    out = {}
    for seg, apps in c.items():
        iv = segs.get(seg)
        types = list(rates.get(seg, {}))
        n = common.requests_in(d, types[0], iv["start"], iv["end"]) if iv and types else 0
        out[seg] = {a: per_request(v, n) for a, v in apps.items()}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("window")
    ap.add_argument("--out")
    a = ap.parse_args()
    d = common.window_dir(a.window)
    r = window_counters(d)
    out = a.out or os.path.join(d, "analysis", "counters.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(r, open(out, "w"), indent=1)
    for seg, apps in r.items():
        for c, v in sorted(apps.items(), key=lambda kv: -kv[1]["threadCpuMs"]):
            if v["threadCpuMs"] < 0.05:
                continue
            print(f"{seg:40s} {c:14s} n={v['n']:5d} thread {v['threadCpuMs']:7.3f} access {v['accessCpuMs']:7.3f} "
                  f"ops {v['operationsCpuMs']:7.3f} engine {v['engineCpuMs']:6.3f} ms/req")
    print(out)


if __name__ == "__main__":
    main()

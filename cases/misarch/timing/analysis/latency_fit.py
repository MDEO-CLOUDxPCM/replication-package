#!/usr/bin/env python3
"""Latency-only delays per mutation (README.md §5.2, RESULTS.md §7) on the instrumented windows ->
timing/latency_fit.json.

    latency_fit.py [--windows approx4_on_w1,approx4_on_w2,approx4_on_w3[,RERUN]] [--parts timing/parts.json]
                   [--out timing/latency_fit.json]

The app server spans of the writing requests are 30-65 % longer than their CPU parts: statement round trips, the
commit (WAL flush) and the publish call to the sidecar wait without burning CPU. Per (request type, service on the
request's synchronous path) in fast-regime steady segments with spans:

    y = server span ms (median over the segment's request traces of the service's summed SERVER spans)
        - CPU parts (own + mapping CPU of the service's operations in that request, parts.json, / r_c = at the
          instrumented configuration the window ran in)
        - DB exec ms (pg_stat_statements, per request; for scans the DB part of the latency is the exec time, which
          runs with parallel workers, not the DB CPU)
        - the service's synchronous calls on the path (Dapr invoke): the callee's server span median + per call
          the calibrated hop (parts.json `middleware`: latency + caller and callee sidecar CPU)
    The CPU parts leave out the jit share of the service in that segment (compiler threads run beside the request;
    a type measured cold has a large jit share), GC stays in (the serial collector stops the request).
    y ~ stmtRoundTripMs x statements + commitDelayMs x commits + publishWaitMs x publishes    (no intercept)

statements = all statements of the service per request (pg_stat_statements calls), publishes = A's publishes of the
service's path operations (probability-weighted). pg_stat_statements has no BEGIN/COMMIT rows, so commits have two
proxies, both fitted: `perWriteStatement` (auto-commit: one commit per write statement) and `perWritingHandler` (one
transaction per (request, service) with writes). The headline is the proxy with the smaller residual SD (window.py
also records pg_stat_wal / pg_stat_database per segment, pgxact.json, not used here). Fitted on the mutations (services with writes); the reads are reported with the fitted a as a
check (their y should be ~ a x statements). Units: ms of wall time per statement / commit / publish.
"""
import argparse
import gzip
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import compose_check  # noqa: E402
import parts as partsmod  # noqa: E402
import queries  # noqa: E402
import speed  # noqa: E402

WINDOWS = "approx4_on_w1,approx4_on_w2,approx4_on_w3"
NOISE = compose_check.NOISE


def request_span_times(d):
    """{type: {service: (median ms, traces)}}: per steady segment, the request traces (those with a gateway span)
    and per service the summed SERVER spans of each trace, median over the traces."""
    p = os.path.join(d, "spans.json.gz")
    if not os.path.exists(p):
        return {}
    spans = json.load(gzip.open(p, "rt"))
    gw = {s["traceId"] for s in spans if s.get("localEndpoint", {}).get("serviceName") == "gateway"}
    out = {}
    for seg, iv in common.segments(d).items():
        if not seg.endswith(":steady"):
            continue
        per = {}
        for s in spans:
            if s.get("kind") != "SERVER" or s["traceId"] not in gw:
                continue
            if not (iv["start"] * 1e6 <= s["timestamp"] < iv["end"] * 1e6):
                continue
            if any(x in s.get("name", "").lower() for x in NOISE):
                continue
            k = (s["traceId"], s.get("localEndpoint", {}).get("serviceName"))
            per[k] = per.get(k, 0.0) + s.get("duration", 0) / 1000
        by = {}
        for (_t, svc), v in per.items():
            by.setdefault(svc, []).append(v)
        out[seg.split(":")[0]] = {svc: (st.median(v), len(v)) for svc, v in by.items()}
    return out


def ols(X, y):
    k = len(X[0])
    A = [[sum(x[i] * x[j] for x in X) for j in range(k)] for i in range(k)]
    b = [sum(x[i] * v for x, v in zip(X, y)) for i in range(k)]
    c = partsmod._solve(A, b)
    if c is None:
        return None
    res = [v - sum(a * xx for a, xx in zip(c, x)) for x, v in zip(X, y)]
    dof = max(1, len(y) - k)
    sd = (sum(r * r for r in res) / dof) ** 0.5
    se = []
    for i in range(k):
        e = partsmod._solve(A, [float(i == j) for j in range(k)])
        se.append(sd * max(0.0, e[i]) ** 0.5 if e else None)
    return {"coef": c, "se": se, "residualSd": sd, "residuals": res}


def points(windows, P, mp):
    import profile_buckets
    r_c = P.get("overheadRatios", {}).get("r_c", {})
    r_all = P.get("overheadRatios", {}).get("r_all", 1.0)
    mw = P["middleware"]
    hop = mw["hopLatencyMs"] + mw["hopCallerCpuMs"] + mw["hopCalleeCpuMs"]
    out, scans, skipped = [], [], []
    for w in windows:
        d = common.window_dir(w)
        spans = request_span_times(d)
        jit = {seg.split(":")[0]: {c: v.get("jitShare") or 0.0 for c, v in cs.items() if c != "_all"}
               for seg, cs in profile_buckets.analyse_window(d, top=0)["segments"].items()}
        q = queries.analyse_window(d, mp)      # fresh, not the window's cache
        reg = speed.window_regime(w)["phases"]
        for t, svcs in spans.items():
            probe = reg.get(f"{t}:steady")
            if probe is None or probe > speed.PLACEMENT_SLOW:
                skipped.append({"type": t, "window": w, "placement": probe})
                continue
            seg = q["segments"].get(f"{t}:steady", {})
            path, fetches, calls, pubs = compose_check.path_structure(mp, t)
            for svc, (span_ms, ntr) in svcs.items():
                if svc in ("gateway", None) or ntr < 5:
                    continue
                path_ops = [o for o in path if mp.ops[o]["service"] == svc]
                if not path_ops:
                    continue            # a follow-up's service, not on the synchronous path
                acc = [a for a in seg.get("accesses", []) if a["service"] == svc]
                stmts = sum(a["callsPerReq"] for a in acc)
                writes = sum(a["callsPerReq"] for a in acc if a["mode"] == "write")
                exec_ms = sum(a["execMsPerReq"] + a.get("planMsPerReq", 0) for a in acc)
                pub = sum(p.get("prob", 1.0) if isinstance(p.get("prob"), (int, float)) else 1.0
                          for o in path_ops for p in mp.ops[o].get("publishes", []))
                callee_ms, ncalls = 0.0, 0
                for o in path_ops:
                    for c in mp.ops[o].get("calls", []):
                        tos = [c["to"]] if isinstance(c["to"], str) else c["to"]
                        tgt = [x for x in tos if x in path and mp.ops[x]["service"] != svc]
                        if c.get("how") in compose_check.SYNC and tgt:
                            ncalls += 1
                            callee_ms += (svcs.get(mp.ops[tgt[0]]["service"]) or (0.0, 0))[0]
                js = jit.get(t, {}).get(svc, 0.0)
                cpu = 0.0
                for o in path_ops:
                    e = common.parts_operation(P, o)
                    if not e:
                        continue
                    br = common.request_parts(e, t)     # per request (parts.json: per execution)
                    cpu += (br["ownCpuMs"] + sum(x["mapCpuMs"] for x in br["accesses"])) / r_c.get(svc, r_all) * (1 - js)
                sync_ms = callee_ms + ncalls * hop
                out.append({"type": t, "service": svc, "window": w, "placement": round(probe, 1), "traces": ntr,
                            "spanMs": round(span_ms, 3), "cpuPartsMs": round(cpu, 3), "dbExecMs": round(exec_ms, 3),
                            "jitShare": round(js, 3), "syncCalls": ncalls, "syncCallsMs": round(sync_ms, 3),
                            "y": round(span_ms - cpu - exec_ms - sync_ms, 3), "statements": round(stmts, 3),
                            "writeStatements": round(writes, 3), "writingHandler": 1.0 if writes > 0.05 else 0.0,
                            "publishes": round(pub, 3), "mutation": writes > 0.05})
                for a in acc:
                    if a["callsPerReq"] >= 0.05:
                        sb = [x.get("sharedBlksPerCall") for x in seg.get("statements", [])
                              if x.get("service") == svc and x.get("class") == a["class"] and x.get("kind") == a["mode"]
                              and x.get("sharedBlksPerCall") is not None]
                        scans.append({"type": t, "service": svc, "class": a["class"], "mode": a["mode"],
                                      "callsPerReq": a["callsPerReq"],
                                      "execMsPerCall": round(a["execMs"] / a["calls"], 4) if a["calls"] else None,
                                      "execMsPerReq": a["execMsPerReq"],
                                      "sharedBlksPerCallMax": max(sb) if sb else None})
    # a type measured in two windows (a re-run window listed last): the later window's point, as parts.py
    last = {(p["type"], p["service"]): i for i, p in enumerate(out)}
    out = [p for i, p in enumerate(out) if last[(p["type"], p["service"])] == i]
    return out, scans, skipped


def fit(pts, commit_key):
    m = [p for p in pts if p["mutation"]]
    X = [[p["statements"], p[commit_key], p["publishes"]] for p in m]
    y = [p["y"] for p in m]
    r = ols(X, y) if len(m) >= 4 else None
    if not r:
        return None
    names = ("stmtRoundTripMs", "commitDelayMs", "publishWaitMs")
    return {"n": len(m), "residualSdMs": round(r["residualSd"], 3),
            **{k: {"value": round(c, 4), "se": round(s, 4) if s is not None else None}
               for k, c, s in zip(names, r["coef"], r["se"])},
            "residuals": [{"type": p["type"], "service": p["service"], "y": p["y"],
                           "fitted": round(p["y"] - e, 3), "residual": round(e, 3)} for p, e in zip(m, r["residuals"])]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", default=WINDOWS)
    ap.add_argument("--parts", default=os.path.join(common.TIMING, "parts.json"))
    ap.add_argument("--out", default=os.path.join(common.TIMING, "latency_fit.json"))
    a = ap.parse_args()
    P = json.load(open(a.parts))
    mp = queries.Mapping()
    pts, scans, skipped = points(a.windows.split(","), P, mp)
    fits = {"perWriteStatement": fit(pts, "writeStatements"), "perWritingHandler": fit(pts, "writingHandler")}
    best = min((k for k in fits if fits[k]), key=lambda k: fits[k]["residualSdMs"])
    f = fits[best]
    a_rt = f["stmtRoundTripMs"]["value"]
    reads = [dict(type=p["type"], service=p["service"], y=p["y"], statements=p["statements"],
                  predicted=round(a_rt * p["statements"] + f["publishWaitMs"]["value"] * p["publishes"], 3))
             for p in pts if not p["mutation"]]
    out = {"latency": {
        "source": "timing/analysis/latency_fit.py (preliminary, v2 windows)", "windows": a.windows.split(","),
        "parts": os.path.relpath(a.parts, common.TIMING), "regime": f"fast segments only (placement <= {speed.PLACEMENT_SLOW} ms/s)",
        "model": "server span - CPU parts (/ r_c) - DB exec = a x statements + b x commits + c x publishes (no intercept)",
        "unit": "ms wall time per statement / commit / publish, instrumented configuration (sampler 0.1)",
        "commitUnit": {"perWriteStatement": "per write statement (auto-commit proxy)",
                       "perWritingHandler": "per (request, service) with writes (one transaction per handler)"}[best],
        "headline": best,
        "stmtRoundTripMs": f["stmtRoundTripMs"], "commitDelayMs": f["commitDelayMs"], "publishWaitMs": f["publishWaitMs"],
        "n": f["n"], "residualSdMs": f["residualSdMs"], "residuals": f["residuals"],
        "alternative": {k: {x: v[x] for x in ("n", "residualSdMs", "stmtRoundTripMs", "commitDelayMs", "publishWaitMs")}
                        for k, v in fits.items() if v and k != best},
        "readsCheck": reads,
        "dbLatencyPerAccess": {"note": "for latency the DB part of an access is its exec time per call (scans run with "
                                       "parallel workers: exec < DB CPU); sharedBlksPerCallMax > 1000 = a large scan",
                               "accesses": scans},
        "points": pts, "skippedSlowSegments": skipped}}
    json.dump(out, open(a.out, "w"), indent=1)
    L = out["latency"]
    print(f"{best}: a = {L['stmtRoundTripMs']}, b = {L['commitDelayMs']}, c = {L['publishWaitMs']}, n = {L['n']}, "
          f"residual SD {L['residualSdMs']} ms")
    for k, v in L["alternative"].items():
        print(f"{k}: a = {v['stmtRoundTripMs']}, b = {v['commitDelayMs']}, c = {v['publishWaitMs']}, SD {v['residualSdMs']}")
    print(a.out)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Composition checks (README.md §5) on parts.json and the windows; writes timing/RESULTS.md.

    compose_check.py [--parts timing/parts.json] [--latency W5,...] [--out timing/RESULTS.md] [--title TEXT]

1. CPU per container: sum of parts = total holds by construction; reported checks are the alpha/beta fit residual
   per (request, service) (flag > 20 %), k_db per DB container (flag outside 0.5-2 x the median), the unmatched
   bucket share (flag > 5 %), the profiler coverage = sampled / cgroup CPU (flag outside 0.7-1.2) and the
   on-vs-off overhead (flag > 10 %).
2. Latency at low load: per request type, the end-to-end prediction along A's synchronous path (gateway request
   + per subgraph fetch: gateway fetch + hop latency + caller/callee hop CPU; + per synchronous Dapr call: a hop;
   + per path operation: own CPU + its accesses' DB ms and mapping CPU, sequential), with the parts scaled to the
   instrumented configuration the window ran in, against the isolated client latency p50. Where the window has
   spans, also the service time per service against the app SERVER spans. Targets: median error within 15 %,
   every type within 30 %.
3. At load (block 7): recorded only (step 5's protocol).
"""
import argparse
import gzip
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

NOISE = ("calllocal/", "pubsub/", "/dapr.proto", "/v1.0/", "/_ecs/", "/health")   # zipkin lower-cases names


def fmt(x, nd=3):
    return "-" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def flag(cond):
    return " **FLAG**" if cond else ""


def span_service_times(d, parts=None):
    """{type: {service: median over the segment's traces of the summed app SERVER span ms of that service}} for the
    steady segments of window d (the median per trace, not the mean per request: a few slow requests, e.g.
    createUserAddress' p90 of 82 ms against a median of 14 ms, dominated the mean)."""
    p = os.path.join(d, "spans.json.gz")
    if not os.path.exists(p):
        return {}
    spans = json.load(gzip.open(p, "rt"))
    segs = common.segments(d) or {k: {"start": s, "end": e} for k, (s, e) in common.phases(d).items()}
    out = {}
    for seg, iv in segs.items():
        if not seg.endswith(":steady"):
            continue
        t = seg.split(":")[0]
        per = {}
        for s in spans:
            if s.get("kind") != "SERVER" or not (iv["start"] * 1e6 <= s["timestamp"] < iv["end"] * 1e6):
                continue
            name = s.get("name", "").lower()
            if any(x in name for x in NOISE):
                continue
            svc = s.get("localEndpoint", {}).get("serviceName")
            k = (s["traceId"], svc)
            per[k] = per.get(k, 0.0) + s.get("duration", 0) / 1000
        by_svc = {}
        for (_tr, svc), v in per.items():
            by_svc.setdefault(svc, []).append(v)
        if by_svc:
            out[t] = {svc: st.median(v) for svc, v in by_svc.items()}
    return out


def segment_speed(d, D_gw, min_gap=0.0):
    """{type: (speed factor, placement probe ms/s)} per steady segment of a latency window: the gateway's CPU rate
    minus its request work (rate x D_gw[type], production gateway totals) over its fast idle rate (>= 1), and the
    placement probe (speed.py)."""
    import speed
    cd = common.cpu_data(d)
    out = {}
    for seg, iv in common.segments(d).items():
        if not seg.endswith(":steady"):
            continue
        t = seg.split(":")[0]
        dur = iv["end"] - iv["start"]
        n = common.requests_in(d, t, iv["start"], iv["end"])
        g = cd.cores(common.PREFIX + "gateway-1", iv["start"], iv["end"])
        f = speed.gateway_factor(g * 1000 if g is not None else None, n / dur * D_gw.get(t, 0.0) if dur else 0.0)
        out[t] = (f, speed.placement(cd, iv["start"], iv["end"]))
    return out


SYNC = ("dapr-invoke", "http", "grpc")


def path_structure(mp, t):
    """The synchronous path of request type t from A's model: the request's plan operations plus the operations
    they call synchronously (Dapr invoke), the number of gateway subgraph fetches (the root fetch + one per
    `_entities` operation of the plan) and the number of synchronous call edges (one hop each). Async follow-ups
    (events, the provider stub's callbacks) are off the path."""
    ops = mp.request_ops(t)
    path = [o for o, r in ops if r in ("plan", "call")]
    plan = [o for o, r in ops if r == "plan"]
    fetches = (1 if plan else 0) + sum("._entities." in o for o in plan)
    calls = pubs = 0
    for o in path:
        for c in mp.ops[o].get("calls", []):
            tos = [c["to"]] if isinstance(c["to"], str) else c["to"]
            if c.get("how") in SYNC and any(x in path for x in tos):
                calls += 1
        pubs += sum(p.get("prob", 1.0) if isinstance(p.get("prob"), (int, float)) else 1.0
                    for p in mp.ops[o].get("publishes", []))
    return path, fetches, calls, pubs


def predict_latency(P, mp, t, on_scale=True):
    """End-to-end prediction at low load (README §5.2), sequential along A's path: gateway request CPU + per
    fetch (gateway fetch CPU + hop latency + caller and callee hop CPU) + per synchronous call (hop) + per publish of
    a path operation (hop latency + publish CPU, weighted by A's probability) + per path operation own CPU + its
    accesses' DB ms and mapping CPU. on_scale: the parts divided by r_c, i.e. at the
    instrumented configuration the latency window ran in (the parts themselves are production values)."""
    mw = P["middleware"]
    r_c = P.get("overheadRatios", {}).get("r_c", {})
    r_all = P.get("overheadRatios", {}).get("r_all", 1.0)
    path, fetches, calls, pubs = path_structure(mp, t)
    hop = mw["hopLatencyMs"] + mw["hopCallerCpuMs"] + mw["hopCalleeCpuMs"]
    tot = mw["gatewayRequestCpuMs"] + fetches * (mw["gatewayFetchCpuMs"] + hop) + calls * hop + \
        pubs * (mw["hopLatencyMs"] + mw["publishCpuMs"])          # the publish call to the sidecar waits
    svc_ms, missing = {}, []
    for o in path:
        e = common.parts_operation(P, o)
        if e is None:
            missing.append(o)
            continue
        br = common.request_parts(e, t)     # per request (parts.json: per execution)
        sa = 1 / r_c.get(e["service"], r_all) if on_scale else 1.0
        sd = 1 / r_c.get(e["service"] + "-db", r_all) if on_scale else 1.0
        ms = br["ownCpuMs"] * sa + sum((x.get("dbMs") or 0) * sd + x["mapCpuMs"] * sa for x in br["accesses"])
        svc_ms[e["service"]] = svc_ms.get(e["service"], 0.0) + ms
        tot += ms
    return {"ms": tot, "fetches": fetches, "calls": calls, "publishes": pubs, "path": path, "services": svc_ms,
            "missing": missing}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts", default=os.path.join(common.TIMING, "parts.json"))
    ap.add_argument("--latency", default="", help="windows of block 5 (low load, one request at a time)")
    ap.add_argument("--out", default=os.path.join(common.TIMING, "RESULTS.md"))
    ap.add_argument("--title", default="Timing campaign: composition checks")
    ap.add_argument("--json", default="", help="also write the check results as JSON")
    a = ap.parse_args()
    import queries
    mp = queries.Mapping()
    P = json.load(open(a.parts))
    J = {}
    L = [f"# {a.title}", "",
         f"Generated by `timing/analysis/compose_check.py` from `{os.path.relpath(a.parts, common.ROOT)}` "
         f"(windows off: {', '.join(w['window'] for w in P['windows']['off']) or '-'}; "
         f"on: {', '.join(w['window'] for w in P['windows']['on'])}).", ""]
    # 1. CPU per container --------------------------------------------------------------------------------------
    L += ["## 1. CPU per (request, container)", "",
          "D = total (ms CPU per request; `off` = production totals (all types in v2), `on x r_c` = instrumented totals "
          "corrected by the per-container on/off ratio, **approximate**). P = persistence CPU (db-driver + mapping buckets), "
          "M = dapr-client bucket (middleware), own = the rest. Flags: fit residual > 20 %, unmatched > 5 %, "
          "coverage outside 0.7-1.2, on/off overhead > 10 %.", "",
          "| request | service | D ms/req | source | P (access) | M (dapr-client) | own | unmatched | instr. | coverage | fit residual | overhead on/off |",
          "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    n_flags, n_rows = 0, 0
    for t, r in P["requests"].items():
        for svc, c in sorted(r["containers"].items(), key=lambda kv: -kv[1]["D"]):
            ov = P["overheadOnVsOff"].get(t, {}).get(svc)
            fr = c.get("fitResidual")
            un = c.get("unmatchedShare")
            cov = c.get("coverage")
            fl = (fr is not None and abs(fr) > 0.2) or (un is not None and un > 0.05) or \
                 (ov is not None and ov > 0.10) or (cov is not None and not 0.7 <= cov <= 1.2)
            n_flags += bool(fl)
            n_rows += 1
            L.append(f"| {t} | {svc} | {fmt(c['D'])} | {c['Dsource']} | {fmt(c['P'])} | {fmt(c['M'])} | {fmt(c['own'])} | "
                     f"{fmt(un)} | {fmt(c.get('instrumentationShare'))} | {fmt(cov)} | {fmt(fr)} | {fmt(ov)}{flag(fl)} |")
    L += ["", f"Flagged (request, service) rows: {n_flags} of {n_rows}.", ""]
    L += ["Fits (persistence CPU = alphaRead x read statements + alphaWrite x write statements + beta x rows, "
          "per service, non-negative, relative weights):", "",
          "| service | alphaRead ms/stmt | alphaWrite ms/stmt | beta ms/row | model | points | median abs residual | residuals > 20 % |",
          "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |"]
    for sv, f in P["fits"].items():
        L.append(f"| {sv} | {f['alphaRead']} | {f['alphaWrite']} | {f['beta']} | {f['model']} | {f['n']} | "
                 f"{fmt(f.get('medianAbsResidual'))} | {f.get('over20')} |")
    allres = [abs(x) for f in P["fits"].values() for x in f["residuals"].values() if x is not None]
    J["fitResiduals"] = {"median": st.median(allres) if allres else None, "n": len(allres),
                         "over20": sum(x > 0.2 for x in allres)}
    L += ["", f"All residuals: median {fmt(J['fitResiduals']['median'])}, {J['fitResiduals']['over20']} of "
              f"{len(allres)} above 20 %.", ""]
    med = st.median([v["median"] for v in P["kDb"].values()]) if P["kDb"] else None
    L += ["k_db = (DB container cgroup CPU - idle - hook psql) / (exec + plan time), on windows:", "",
          "| DB container | k_db (median) | segments | flag |", "| --- | ---: | ---: | --- |"]
    for c, v in P["kDb"].items():
        fl = med is not None and not (0.5 * med <= v["median"] <= 2 * med)
        L.append(f"| {c} | {v['median']} | {v['n']} | {'outlier' if fl else ''} |")
    # overhead per container
    bc = P.get("overheadRatios", {}).get("byContainer", {})
    L += ["", "On/off overhead per container (D_on / D_off - 1 over the paired types; pooled = sum D_on / sum D_off - 1; "
              "flag > 10 %):", "",
          "| container | pairs | pooled overhead | per type | r_c used | how | flag |",
          "| --- | ---: | ---: | --- | ---: | --- | --- |"]
    J["overheadFlags"] = []
    for c, v in sorted(bc.items(), key=lambda kv: (common_role(kv[0]), kv[0])):
        if not v["n"]:
            continue
        fl = v["overheadPooled"] is not None and v["overheadPooled"] > 0.10
        if fl:
            J["overheadFlags"].append(c)
        L.append(f"| {c} | {v['n']} | {fmt(v['overheadPooled'])} | "
                 f"{', '.join(f'{t} {x:+.2f}' for t, x in sorted(v['overheads'].items()))} | {v['r']} | {v['method']} | "
                 f"{'**> 10 %**' if fl else ''} |")
    L += ["", f"Role medians of r_c (used for containers with fewer than 2 pairs): "
              f"{json.dumps(P.get('overheadRatios', {}).get('r_role', {}))}, all {P['overheadRatios'].get('r_all')}.", ""]
    # 2. Latency -------------------------------------------------------------------------------------------------
    L += ["## 2. Latency at low load", ""]
    lat_windows = [common.window_dir(x) for x in a.latency.split(",") if x]
    measured, e2e, e2e_all = {}, {}, {}
    for d in lat_windows:
        measured.update(span_service_times(d, P))
    os.environ.setdefault("MISARCH_STACK", "kotlin")
    sys.path.insert(0, common.CAL_SCRIPTS)
    try:
        import analyze_iso
        for d in lat_windows:
            for t, v in analyze_iso.analyze_window(d)["types"].items():
                e2e[t] = v["latency_isolated_ms"].get("p50") or v["latency_ms"].get("p50")
                e2e_all[t] = {"p50": v["latency_ms"].get("p50"), "isoP50": v["latency_isolated_ms"].get("p50"),
                              "n": v["n"], "err": v["errRate"]}
    except Exception as ex:
        L.append(f"(client latencies unavailable: {ex})")
    # speed regime per segment (speed.py): gateway production totals from the off windows
    D_gw = {}
    for w in P["windows"]["off"]:
        try:
            import parts as _parts
            for t, v in _parts.iso_totals(common.window_dir(w["window"]))[0].items():
                D_gw[t] = v["D"].get("gateway", 0.0)
        except Exception:
            pass
    spd = {}
    for d in lat_windows:
        try:
            spd.update(segment_speed(d, D_gw))
        except Exception as ex:
            L.append(f"(speed probe unavailable: {ex})")
    if measured:
        L += ["Service time per service: median over the segment's traces of the summed app SERVER spans of the "
              "service (spans exist for the types listed; see RESULTS.md for the coverage), against the predicted "
              "service time (own CPU + accesses of the path operations of that service, instrumented scaling) and "
              "the same x the segment's speed factor:", "",
              "| request | service | predicted ms | x speed | measured median ms | error | error x speed |",
              "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
        J["spanServiceTimes"] = {}
        for t in P["requests"]:
            if t not in measured:
                continue
            pr = predict_latency(P, mp, t)
            f = spd.get(t, (1.0, None))[0]
            for svc, ms in pr["services"].items():
                m = measured.get(t, {}).get(svc)
                err = (ms - m) / m if m else None
                errs_ = (ms * f - m) / m if m else None
                L.append(f"| {t} | {svc} | {fmt(ms)} | {fmt(ms * f)} | {fmt(m)} | {fmt(err)} | {fmt(errs_)} |")
                J["spanServiceTimes"].setdefault(t, {})[svc] = {"predicted": round(ms, 3), "measured": m,
                                                               "error": err, "errorSpeed": errs_, "speed": f}
        L.append("")
    else:
        L += ["No spans in the latency window(s) (the Zipkin fetch failed), so only the end-to-end check below.", ""]
    L += ["End to end: prediction along A's synchronous path (sequential; fetches = gateway subgraph fetches, "
          "calls = synchronous Dapr invocations), parts scaled to the instrumented configuration of the window "
          "(/ r_c); `prod` = the production parts. Measured: client p50 of the requests that did not overlap another "
          "request (analyze_iso), latency window(s) " + (", ".join(os.path.basename(d) for d in lat_windows) or "-") + ".",
          "Speed: the segment's speed factor (gateway probe, speed.py; 1 = fast regime) and the placement probe "
          "(ms/s; > 32 = slow regime); `error x speed` compares the prediction x speed.",
          "", "| request | fetches | calls | publishes | predicted ms | predicted prod ms | measured p50 ms | error | "
              "speed | placement | error x speed | flag |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    errs, errs_s, errs_fast, rows = [], [], [], {}
    for t in sorted(e2e):
        if t not in P["requests"] and not mp.request_ops(t):
            L.append(f"| {t} | - | - | - | - | - | {fmt(e2e[t], 1)} | - | no parts (outside the app containers) |")
            rows[t] = {"measured": e2e[t], "predicted": None}
            continue
        pr = predict_latency(P, mp, t)
        pp = predict_latency(P, mp, t, on_scale=False)
        m = e2e[t]
        err = (pr["ms"] - m) / m if m else None
        f, plc = spd.get(t, (1.0, None))
        err_s = (pr["ms"] * f - m) / m if m else None
        if err is not None:
            errs.append(abs(err))
            errs_s.append(abs(err_s))
            if plc is not None and plc <= 32.0:
                errs_fast.append(abs(err))
        miss = f"missing parts: {', '.join(pr['missing'])}" if pr["missing"] else ""
        L.append(f"| {t} | {pr['fetches']} | {pr['calls']} | {pr['publishes']:.2f} | {fmt(pr['ms'], 1)} | {fmt(pp['ms'], 1)} | {fmt(m, 1)} | "
                 f"{fmt(err, 2)} | {fmt(f, 2)} | {fmt(plc, 1)} | {fmt(err_s, 2)} | "
                 f"{'**> 30 %**' if err is not None and abs(err) > 0.3 else ''} {miss} |")
        rows[t] = {"measured": m, "predicted": round(pr["ms"], 3), "predictedProd": round(pp["ms"], 3),
                   "speed": round(f, 3), "placement": plc, "errorSpeed": round(err_s, 4) if err_s is not None else None,
                   "error": round(err, 4) if err is not None else None, "fetches": pr["fetches"],
                   "calls": pr["calls"], "publishes": pr["publishes"], "services": {k: round(v, 3) for k, v in pr["services"].items()},
                   "missing": pr["missing"], **e2e_all.get(t, {})}
    J["latency"] = rows
    if errs:
        J["latencySummary"] = {"medianAbsError": st.median(errs), "max": max(errs), "n": len(errs),
                               "over30": sum(x > 0.3 for x in errs)}
        J["latencySummarySpeed"] = {"medianAbsError": st.median(errs_s), "max": max(errs_s), "n": len(errs_s),
                                    "over30": sum(x > 0.3 for x in errs_s)}
        J["latencySummaryFast"] = ({"medianAbsError": st.median(errs_fast), "max": max(errs_fast), "n": len(errs_fast),
                                    "over30": sum(x > 0.3 for x in errs_fast)} if errs_fast else None)
        L += ["", f"End-to-end error: median {st.median(errs):.3f}, max {max(errs):.3f}, "
                  f"{sum(x > 0.3 for x in errs)} of {len(errs)} above 30 % (targets: median 0.15, each 0.30).",
              f"With the prediction x speed: median {st.median(errs_s):.3f}, {sum(x > 0.3 for x in errs_s)} of "
              f"{len(errs_s)} above 30 %." + (f" Fast-regime segments only (placement <= 32 ms/s): median "
                                              f"{st.median(errs_fast):.3f}, {sum(x > 0.3 for x in errs_fast)} of "
                                              f"{len(errs_fast)} above 30 %." if errs_fast else ""), ""]
    # 3. At load --------------------------------------------------------------------------------------------------
    L += ["## 3. At load (block 7)", ""]
    det = P.get("kAtLoadDetail")
    if det:
        L += [f"Window {det['window']}, levels <= {det['maxLevel']}: " +
              ", ".join(f"L{x['level']} {x['X']:.1f} sessions/s ({x['requestsPerS']:.0f} req/s, {x['errors']} errors)"
                        for x in det["levels"]),
              "", "k_c with the session cardinalities in the prediction (factorial per-item, coupon and payment terms, "
                  "`cardinality ms/order`) and without (`k no card.`).", "",
              "| container | k_c | k no card. | cardinality ms/order | method | D at load ms/session | predicted from isolation | R2 | capped levels |",
              "| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |"]
        for c, v in sorted(det["containers"].items(), key=lambda kv: -kv[1].get("D_msPerSession", 0)):
            if "k" not in v or v.get("isoD_msPerSession", 0) < 0.1:
                continue
            L.append(f"| {c} | {v['k']} | {v.get('kNoCardinality', '-')} | {v.get('cardinalityMsPerOrder', 0)} | "
                     f"{v['method']} | {v['D_msPerSession']} | {v['isoD_msPerSession']} | {v['R2']} | "
                     f"{', '.join(str(x) for x in v.get('cappedLevels') or [])} |")
    else:
        L.append("No at-load data in this parts.json.")
    L.append("")
    open(a.out, "w").write("\n".join(L) + "\n")
    if a.json:
        json.dump(J, open(a.json, "w"), indent=1)
    print(a.out)


def common_role(c):
    import parts
    return parts.container_role(c)


if __name__ == "__main__":
    main()

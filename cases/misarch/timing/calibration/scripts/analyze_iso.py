#!/usr/bin/env python3
"""Per-request-type service demands from isolation windows (task 4b/4c).

    analyze_iso.py --windows results/raw/W1,results/raw/W2 --out results/iso_main.json

For every request type T measured alone at constant Poisson rate X (phases T:warm, T:steady, T:drain):
  D_c(T) = (U_c(steady) - B_c) / X        [ms CPU per request, per container c]
B_c is the idle CPU rate of container c in the same window (phases idle + idle_end). Because the system is in steady
state during the steady phase, asynchronous follow-up work of earlier requests (event chains) is included as long as
the chain is shorter than the steady phase; the drain phase is used to check that the chain has drained and to see
which containers keep working after the last request (asynchronous tail).
Uncertainty: SE within a window from 5 sub-intervals of the steady phase; across windows the stddev of the per-window
estimates is reported.
"""
import argparse
import csv
import json
import math
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cpuan import MONGO_DBS, CpuData, classify  # noqa: E402
from stack import short  # noqa: E402

LIMITED = {}


def pct(v, q):
    if not v:
        return None
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(math.ceil(q * len(v))) - 1))]


def analyze_window(d, sub=5, scheduled=()):
    """scheduled: CpuData's scheduled-job masks (the jobs' CPU at their firing times is not a request's)."""
    meta = json.load(open(os.path.join(d, "meta.json")))
    cd = CpuData(d, despike_keys=MONGO_DBS, scheduled=scheduled)
    win = {}
    try:
        win = json.load(open(os.path.join(d, "window.json")))
    except Exception:
        pass
    ph = {p["name"]: (p["start"], p["end"]) for p in meta["phases"]}
    reqs = list(csv.DictReader(open(os.path.join(d, "requests.csv"))))
    keys = cd.keys("misarch-") + ["engine:docker", "engine:containerd"]
    # baseline
    idle_iv = [(s + 5, e) for n, (s, e) in ph.items() if n in ("idle", "idle_end") and e - s > 10]
    base, base_first, base_last = {}, {}, {}
    for k in keys:
        tot_u = sum((cd.usec(k, s, e) or 0) for s, e in idle_iv)
        tot_t = sum(e - s for s, e in idle_iv)
        base[k] = tot_u / 1e6 / tot_t if tot_t else 0.0
        if idle_iv:
            base_first[k] = cd.cores(k, *idle_iv[0]) or 0.0
            base_last[k] = cd.cores(k, *idle_iv[-1]) or 0.0
    types = sorted({n.split(":")[0] for n in ph if n.endswith(":steady")}, key=lambda t: ph[t + ":steady"][0])
    # local baselines: idle interval right before each segment (T:pre, or the window's idle phase for the first one)
    # and right after it (next segment's pre, or idle_end); baseline = mean of the two rates
    idle_list = sorted([(e - s, s, e, n) for n, (s, e) in ph.items() if n.endswith(":pre") or n in ("idle", "idle_end")],
                       key=lambda x: x[1])

    def local_base(k, t_start, t_end, n_near=5):
        """Median idle rate of the n_near idle phases closest to the segment (each at most its last 30 s): tracks slow
        drift but is robust against the noisy idle of e.g. the gateway (8 node forks) and single outliers."""
        mid = (t_start + t_end) / 2
        near = sorted(idle_list, key=lambda x: abs((x[1] + x[2]) / 2 - mid))[:n_near]
        vals = []
        for _, a0, a1, _n in near:
            a0 = max(a0, a1 - 30)
            c = cd.cores(k, a0 + 1, a1)
            if c is not None:
                vals.append(c)
        return st.median(vals) if vals else base[k]
    res = {"window": os.path.basename(d), "valid": win.get("valid"), "foreign_mean": win.get("foreign_mean_cores"),
           "despiked": cd.despiked,
           "scheduled": {k: {x: v[x] for x in ("cron", "ops", "firings", "removedCpuS")} for k, v in cd.scheduled.items()},
           "baseline_cores": {k: round(v, 5) for k, v in base.items()},
           "baseline_drift_cores": {k: round(base_last[k] - base_first[k], 5) for k in base_first},
           "types": {}}
    for t in types:
        s0, s1 = ph[t + ":steady"]
        w0 = ph.get(t + ":warm", (s0, s0))[0]
        d0, d1 = ph.get(t + ":drain", (s1, s1))
        rt = t.split("@")[0]          # rate-sweep segments are named <type>@<rate>
        rs = [r for r in reqs if r["type"] == rt and r["phase"] == t + ":steady"]
        rs_all = [r for r in reqs if r["type"] == rt and r["phase"].split(":")[0] == t]
        n, nok = len(rs), sum(r["ok"] == "1" for r in rs)
        X = n / (s1 - s0)
        lat = [float(r["latency_ms"]) for r in rs if r["ok"] == "1"]
        iv = sorted((float(r["epoch_send"]), float(r["epoch_send"]) + float(r["latency_ms"]) / 1000)
                    for r in reqs if r["epoch_send"] and r["latency_ms"])
        iso_lat = []
        starts = [x[0] for x in iv]
        import bisect as _b
        for r in rs:
            if r["ok"] != "1":
                continue
            a0 = float(r["epoch_send"])
            a1 = a0 + float(r["latency_ms"]) / 1000
            i = _b.bisect_left(starts, a0)
            overl = any(iv[j][0] < a1 and iv[j][1] > a0 and abs(iv[j][0] - a0) > 1e-6
                        for j in range(max(0, i - 50), min(len(iv), i + 50)))
            if not overl:
                iso_lat.append(float(r["latency_ms"]))
        errs = {}
        for r in rs_all:
            if r["ok"] != "1":
                errs[r["error"][:90]] = errs.get(r["error"][:90], 0) + 1
        cont = {}
        edges = [s0 + i * (s1 - s0) / sub for i in range(sub + 1)]
        seg_start = ph.get(t + ":warm", (s0, s0))[0]
        seg_end = ph.get(t + ":drain", (s1, s1))[1]
        pre0 = ph.get(t + ":pre", (seg_start, seg_start))[0]
        fprof = cd.foreign_profile(pre0, seg_end, step=10)
        fmean = cd.foreign_cores(pre0, seg_end)
        seg_valid = fmean < 0.3 and (max(fprof) if fprof else 0) < 1.1
        lb = {k: local_base(k, seg_start, seg_end) for k in keys}
        for k in keys:
            U = cd.cores(k, s0, s1)
            if U is None:
                continue
            D = (U - lb[k]) / X * 1000 if X else None
            parts = []
            for i in range(sub):
                a, b = edges[i], edges[i + 1]
                nn = sum(1 for r in rs if a <= float(r["epoch_send"]) < b)
                if nn:
                    parts.append(((cd.cores(k, a, b) or 0) - lb[k]) * (b - a) / nn * 1000)
            se = st.stdev(parts) / math.sqrt(len(parts)) if len(parts) > 1 else None
            n_sent_total = len([r for r in rs_all if r["phase"] in (t + ":warm", t + ":steady")])
            tot_u = cd.usec(k, w0, d1) or 0
            D_total = (tot_u / 1e6 - lb[k] * (d1 - w0)) / n_sent_total * 1000 if n_sent_total else None
            tail = ((cd.usec(k, d0 + 1, d1) or 0) / 1e6 - lb[k] * (d1 - d0 - 1)) / n_sent_total * 1000 \
                if n_sent_total else None
            th, nth = cd.throttled(k, s0, s1)
            svc, role = classify(k) if k.startswith(("misarch-", "sum:")) else ("docker-engine", "engine")
            cont[k] = {"service": svc, "role": role, "D": D, "se": se, "D_total": D_total, "tail": tail,
                       "U": U, "base": lb[k], "baseWindow": base[k], "throttled_s_per_s": th, "throttled_periods_per_s": nth}
        res["types"][t] = {"segmentValid": seg_valid, "foreignMeanCores": round(fmean, 3),
                           "foreignMax10sCores": max(fprof) if fprof else None, "rate_target": meta["plan"]["phases"][[p["name"] for p in meta["plan"]["phases"]].index(
            t + ":steady")]["rates"].get(rt), "X": X, "n": n, "ok": nok, "errRate": 1 - nok / n if n else None,
            "errors_all_phases": errs,
            "latency_ms": {"n": len(lat), "mean": st.mean(lat) if lat else None, "p50": pct(lat, .5),
                           "p95": pct(lat, .95), "p99": pct(lat, .99), "max": max(lat) if lat else None},
            "latency_isolated_ms": {"n": len(iso_lat), "mean": st.mean(iso_lat) if iso_lat else None,
                                    "p50": pct(iso_lat, .5), "p95": pct(iso_lat, .95)},
            "containers": cont}
    return res


def combine(wins, min_ms=0.05):
    out = {}
    types = []
    for w in wins:
        for t in w["types"]:
            if t not in types:
                types.append(t)
    for t in types:
        per = [w["types"][t] for w in wins if t in w["types"] and w["types"][t]["segmentValid"]]
        excluded = [w["window"] for w in wins if t in w["types"] and not w["types"][t]["segmentValid"]]
        if not per:
            out[t] = {"excludedSegments": excluded, "nValidSegments": 0}
            continue
        keys = sorted({k for p in per for k in p["containers"]})
        rows = []
        for k in keys:
            Ds = [p["containers"][k]["D"] for p in per if k in p["containers"] and p["containers"][k]["D"] is not None]
            ses = [p["containers"][k]["se"] for p in per if k in p["containers"] and p["containers"][k]["se"]]
            tails = [p["containers"][k]["tail"] for p in per if k in p["containers"] and p["containers"][k]["tail"] is not None]
            Dt = [p["containers"][k]["D_total"] for p in per if k in p["containers"] and p["containers"][k]["D_total"] is not None]
            thr = [p["containers"][k]["throttled_s_per_s"] or 0 for p in per if k in p["containers"]]
            c0 = per[0]["containers"].get(k) or next(p["containers"][k] for p in per if k in p["containers"])
            m = st.mean(Ds)
            sd = st.stdev(Ds) if len(Ds) > 1 else None
            se_w = math.sqrt(sum(s * s for s in ses)) / len(ses) if ses else None
            unc = max(x for x in [sd / math.sqrt(len(Ds)) if sd else None, se_w] if x is not None) if (sd or se_w) else None
            rows.append({"container": k, "service": c0["service"], "role": c0["role"],
                         "cpuMsPerRequest": round(m, 3), "stddev": round(sd, 3) if sd is not None else None,
                         "seWithinWindow": round(se_w, 3) if se_w is not None else None, "nWindows": len(Ds),
                         "cpuMsPerRequestTotalAttribution": round(st.mean(Dt), 3) if Dt else None,
                         "asyncTailMsPerRequest": round(st.mean(tails), 3) if tails else None,
                         "throttledFraction": round(st.mean(thr), 4) if thr else None,
                         "significant": bool(m > min_ms and (unc is None or m > 2 * unc))})
        rows.sort(key=lambda r: -r["cpuMsPerRequest"])
        lat = [p["latency_ms"] for p in per]
        out[t] = {"nValidSegments": len(per), "excludedSegments": excluded,
                  "rate": st.mean(p["X"] for p in per), "nRequests": sum(p["n"] for p in per),
                  "errorRate": sum(p["n"] - p["ok"] for p in per) / max(1, sum(p["n"] for p in per)),
                  "errors": [p["errors_all_phases"] for p in per if p["errors_all_phases"]],
                  "latencyMs": {q: round(st.mean(l[q] for l in lat if l[q] is not None), 2) if any(l[q] for l in lat) else None
                                for q in ("mean", "p50", "p95", "p99")},
                  "latencyMsPerWindow": lat,
                  "latencyIsolatedMs": {q: round(st.mean(p["latency_isolated_ms"][q] for p in per
                                                         if p["latency_isolated_ms"][q] is not None), 2)
                                        if any(p["latency_isolated_ms"][q] for p in per) else None
                                        for q in ("mean", "p50", "p95")},
                  "nIsolated": sum(p["latency_isolated_ms"]["n"] for p in per),
                  "containers": rows}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stack", help="ignored here (container names come from the data); accepted for symmetry")
    a = ap.parse_args()
    wins = [analyze_window(d.strip()) for d in a.windows.split(",") if d.strip()]
    comb = combine(wins)
    json.dump({"windows": wins, "combined": comb}, open(a.out, "w"), indent=1)
    for t, r in comb.items():
        if not r.get("nValidSegments"):
            print(f"{t:22s} no valid segment (excluded: {r.get('excludedSegments')})")
            continue
        tot = sum(x["cpuMsPerRequest"] for x in r["containers"] if x["significant"] and x["role"] != "engine")
        top = ", ".join(f"{short(x['container'])}={x['cpuMsPerRequest']:.2f}±{(x['stddev'] or x['seWithinWindow'] or 0):.2f}"
                        for x in r["containers"] if x["significant"])[:400]
        print(f"{t:22s} X={r['rate']:.2f}/s err={r['errorRate']:.3f} lat p50={r['latencyMs']['p50']} "
              f"p95={r['latencyMs']['p95']} | total={tot:.1f} ms | {top}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Rate sensitivity of the totals of rare (low-rate) request types (README.md §3.4).

    sensitivity.py [--parts timing/parts.json] [--pilot pilot_w1,pilot_w2,pilot_w3]
                   [--mid approx4_off_w1,approx4_off_w2,approx4_off_w3[,RERUN]] [--low approx4_mech_on_w1]
                   [--max-rate 10] [--out timing/raw/sensitivity.json]

The cost per request measured at a type's mid rate is higher for types whose mid rate is low. Two causes:
background CPU that the idle baseline does not remove (drift; it adds b/X per request at rate X) and a real
per-request effect at low rates (JIT state of rarely run code paths). Model per type, summed over its path
containers only (the request's app containers from parts.json, their -db, -dapr and -ecs, the gateway and its
sidecar; other containers carry only drift):  D(X) = a + b / X.
- Shape: the pilot windows (block 1, production configuration, 3 rates per type, 20 s each, on
  the data state of their own run) give a and b by least squares; the ratio a / D_pilot(X_mid) is transferred to this campaign's mid-rate
  total: asymptote = D_mid x a / (a + b / X_mid).
- Check (fast regime): the copy-write types ran in block 2 at the mid rate and in the --low window (mech_on_w1) at
  the low rate (1-2/s), both uninstrumented; two points give a and b (order's containers excluded: the copies
  are on in the mechanisms window).
- Drift: the same fit over the containers off the path (their true demand is ~0), whose b is the background term.
"""
import argparse
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import parts  # noqa: E402

TRACE = ("zipkin", "otel-collector", "engine:")


def fit_inverse(points):
    """Least squares D = a + b / X over [(X, D)] -> (a, b); with one point (D, 0)."""
    pts = [(x, d) for x, d in points if x and x > 0 and d is not None]
    if not pts:
        return None, None
    if len(pts) == 1:
        return pts[0][1], 0.0
    us = [1.0 / x for x, _ in pts]
    ds = [d for _, d in pts]
    mu, md = sum(us) / len(us), sum(ds) / len(ds)
    suu = sum((u - mu) ** 2 for u in us)
    if suu <= 0:
        return md, 0.0
    b = sum((u - mu) * (d - md) for u, d in zip(us, ds)) / suu
    return md - b * mu, b


def path_containers(req_entry, via_gateway=True):
    """The request's app containers (parts.json requests[t].containers), their DB and sidecars, and the gateway
    with its sidecar when the request goes through it (not registration and login: Keycloak only)."""
    svcs = set((req_entry or {}).get("containers", {}))
    out = {"gateway", "gateway-dapr"} if via_gateway else set()
    for s in svcs:
        out |= {s, f"{s}-db", f"{s}-dapr", f"{s}-ecs"}
    return out


def sums(D, path, exclude=()):
    on = sum(v for c, v in D.items() if c in path and not c.startswith(exclude))
    off = sum(v for c, v in D.items() if c not in path and not c.startswith(TRACE) and not c.startswith(exclude))
    return on, off


def via_gateway(mp, t):
    return any("graphql" in (mp.ops[o].get("trigger") or {}) for o, role in mp.request_ops(t) if role == "plan")


def analyse(P, pilot_ws, mid_ws, low_ws, max_rate=10.0):
    import queries
    mp = queries.Mapping()
    mid, low, pilot = {}, {}, {}
    for w in mid_ws:
        mid.update(parts.iso_totals(common.window_dir(w))[0])
    for w in low_ws:
        low.update(parts.iso_totals(common.window_dir(w))[0])
    for w in pilot_ws:
        for k, v in parts.iso_totals(common.window_dir(w))[0].items():
            t, _, r = k.partition("@")
            if r:
                pilot.setdefault(t, []).append(v)
    out = {}
    for t, v in sorted(mid.items()):
        if v["X"] is None or v["X"] > max_rate or t not in P["requests"]:
            continue
        path = path_containers(P["requests"].get(t), via_gateway(mp, t))
        d_mid, drift_mid = sums(v["D"], path)
        row = {"midRate": round(v["X"], 3), "midPathMs": round(d_mid, 3), "midOffPathMs": round(drift_mid, 3),
               "pathContainers": sorted(c for c in path if c in v["D"])}
        if t in pilot:
            pts = [(p["X"], sums(p["D"], path)[0]) for p in pilot[t]]
            dpts = [(p["X"], sums(p["D"], path)[1]) for p in pilot[t]]
            a, b = fit_inverse(pts)
            da, db = fit_inverse(dpts)
            at_mid = a + b / v["X"] if a is not None else None
            ratio = a / at_mid if at_mid and at_mid > 0 else None
            row["pilot"] = {"points": [(round(x, 2), round(d, 3)) for x, d in sorted(pts)], "a": round(a, 3),
                            "b": round(b, 3), "atMidRate": round(at_mid, 3) if at_mid else None,
                            "offPath": {"points": [(round(x, 2), round(d, 3)) for x, d in sorted(dpts)],
                                        "a": round(da, 3), "b": round(db, 3)}}
            if ratio is not None:
                row["asymptoteRatio"] = round(max(0.0, min(1.5, ratio)), 3)
                row["asymptotePathMs"] = round(d_mid * row["asymptoteRatio"], 3)
        if t in low:
            ex = ("order",)
            dm = sums(v["D"], path, ex)[0]
            dl = sums(low[t]["D"], path, ex)[0]
            a2, b2 = fit_inverse([(v["X"], dm), (low[t]["X"], dl)])
            row["v2TwoRates"] = {"excluding": "order*", "mid": [round(v["X"], 2), round(dm, 3)],
                                 "low": [round(low[t]["X"], 2), round(dl, 3)], "a": round(a2, 3), "b": round(b2, 3),
                                 "asymptoteRatio": round(a2 / dm, 3) if dm > 0 else None}
        out[t] = row
    # impact on the parts: app CPU (own + mapping) and DB of each operation measured only in affected types
    ratios = {t: r.get("asymptoteRatio") for t, r in out.items() if r.get("asymptoteRatio") is not None}
    impact = {}
    for o, e in P["operations"].items():
        rs = [ratios[t] for t in e["byRequest"] if t in ratios]
        if not rs or len(rs) < len(e["byRequest"]):
            continue
        cpu = e["ownCpuMs"] + sum(a["mapCpuMs"] for a in e["accesses"])
        db = sum(a["dbMs"] for a in e["accesses"])
        f = st.mean(rs)
        impact[o] = {"appCpuMs": round(cpu, 3), "appCpuMsAsymptote": round(cpu * f, 3), "dbMs": round(db, 3),
                     "dbMsAsymptote": round(db * f, 3), "factor": round(f, 3), "requests": sorted(e["byRequest"])}
    return {"source": "timing/analysis/sensitivity.py", "model": "D(X) = a + b/X over the path containers",
            "maxRate": max_rate, "windows": {"pilot": pilot_ws, "mid": mid_ws, "low": low_ws},
            "types": out, "operations": impact}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts", default=os.path.join(common.TIMING, "parts.json"))
    ap.add_argument("--pilot", default="pilot_w1,pilot_w2,pilot_w3")
    ap.add_argument("--mid", default="approx4_off_w1,approx4_off_w2,approx4_off_w3")
    ap.add_argument("--low", default="approx4_mech_on_w1")
    ap.add_argument("--max-rate", type=float, default=10.0)
    ap.add_argument("--out", default=os.path.join(common.RAW, "sensitivity.json"))
    a = ap.parse_args()
    P = json.load(open(a.parts))
    r = analyse(P, [x for x in a.pilot.split(",") if x], [x for x in a.mid.split(",") if x],
                [x for x in a.low.split(",") if x], a.max_rate)
    json.dump(r, open(a.out, "w"), indent=1)
    for t, v in r["types"].items():
        p = v.get("pilot", {})
        print(f"{t:44s} X {v['midRate']:5.2f} mid {v['midPathMs']:7.2f} (off-path {v['midOffPathMs']:6.2f}) "
              f"pilot {p.get('points')} a {p.get('a')} b {p.get('b')} -> ratio {v.get('asymptoteRatio')} "
              f"two rates {v.get('v2TwoRates', {}).get('asymptoteRatio')}")
    print(a.out)


if __name__ == "__main__":
    main()

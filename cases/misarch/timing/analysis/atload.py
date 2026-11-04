#!/usr/bin/env python3
"""At-load scale k_c per container from the session curve (README.md §3.4, block 7), by the calibration's
utilisation-law method (re-implemented here on this campaign's file formats).

    atload.py --window approx4_atload_w1 --off approx4_off_w1,... --on approx4_on_w1,... [--max-level 0.75]
              [--factorial timing/raw/factorial.json]

Per level L<f>:steady of the session window: U_c = measured cores of container c (cgroup, cpu.csv), X = sessions
started per s, and the prediction P_c = sum_t rate_t * D(t, c) with rate_t the requests of type t sent per s
in the level (requests.csv) and D(t, c) the isolation totals of this campaign (off totals; on x r_c for the types
measured only instrumented, parts.overhead_ratios). Fits over the levels <= --max-level (default 0.75: from level
1.0 on the load client runs out of file descriptors, RESULTS.md §0), without the levels where the container itself is
at >= 95 % of its CPU limit:
  U_c = U0_c + D_c X,   P_c = P0_c + Dp_c X,   k_c = D_c / Dp_c
when there are >= 3 levels, R^2 >= 0.9 and both slopes > 0 (the calibration's rule); otherwise the mean ratio
(U - U_idle) / P over the two highest levels used (U_idle: the window's idle phases, else the intercept).
Containers whose prediction is ~0 are unmodelled (background).

Cardinalities: the isolation documents order one item of one unit, no coupon, Gatling's first payment information
(PREPAYMENT or INVOICE, about half each); the sessions order 1.25 items, 1.25 units per item, a coupon in 10 % and INVOICE / PREPAYMENT / CREDIT_CARD 0.445 / 0.416 /
0.139 (workload/sessions.json cardinalities). With --factorial, the prediction adds per order and app, DB or
sidecar container sum_k coef_k (x_k(session) - x_k(isolation)) over items, units and coupon from the factorial's
speed-normalised fits (coefficients within 2 standard errors of 0 are dropped; the payment-method terms are left
out, README.md §3.6), times r_c (the factorial is instrumented), at the level's order rate. k_c
is reported with (`k`) and without (`kNoCardinality`) that term.
"""
import argparse
import collections
import csv
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import parts  # noqa: E402


TRACE_PIPELINE = ("zipkin", "otel-collector")
# expected factorial design variables (factorial.design_row without the intercept): items - 1, items x (qty - 1),
# coupon, PREPAYMENT, CREDIT_CARD, stock 600
ISO_CARDINALITIES = {"item": 0.0, "unit": 0.0, "coupon": 0.0, "PRE": 0.5, "CC": 0.0, "s600": 0.0}
SESSION_CARDINALITIES = {"item": 0.25, "unit": 1.25 * 0.25, "coupon": 0.1, "PRE": 0.416, "CC": 0.139, "s600": 0.0}
MIN_MS = 0.2        # demands below this (ms/request) are noise (parts.py --min-ms)
MIN_PRED_CORES = 0.005   # a container whose predicted CPU stays below this at every level is unmodelled
CAPPED = 0.95       # a level where the container used >= 95 % of its CPU limit is saturated: not on the line


def cpu_limits(d):
    """{container: limit in cores} from containers.json (cgroup cpu.max), None = unlimited."""
    out = {}
    for k, v in (common.load_json(d, "containers.json", {}) or {}).get("containers", {}).items():
        q, _, per = str(v.get("cpu.max", "max")).partition(" ")
        if q != "max" and per:
            out[k] = int(q) / int(per)
    return out


def fit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return my, 0.0, 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    d = sxy / sxx
    u0 = my - d * mx
    ss = sum((y - my) ** 2 for y in ys)
    res = sum((y - u0 - d * x) ** 2 for x, y in zip(xs, ys))
    return u0, d, (1 - res / ss) if ss > 0 else 0.0


def scale(xs, us, ps, idle=None, min_r2=0.9):
    """The calibration's rule for one container -> (k, method, U0, D, Dp, R2)."""
    u0, d, r2 = fit(xs, us) if len(xs) >= 2 else (0.0, 0.0, 0.0)
    _, dp, _ = fit(xs, ps) if len(xs) >= 2 else (0.0, 0.0, 0.0)
    if len(xs) >= 3 and r2 >= min_r2 and d > 0 and dp > 0:
        return d / dp, "slope", u0, d, dp, r2
    top = sorted(range(len(xs)), key=lambda i: xs[i])[-2:]
    base = idle if idle is not None else u0
    rs = [(us[i] - base) / ps[i] for i in top if ps[i] > 0]
    if rs:
        return sum(rs) / len(rs), "ratio top-2 levels", u0, d, dp, r2
    return 1.0, "isolation", u0, d, dp, r2


def levels(d, max_level):
    meta = common.load_json(d, "meta.json")
    out = []
    for p in meta["phases"]:
        n = p["name"]
        if n.startswith("L") and n.endswith(":steady"):
            f = float(n[1:].split(":")[0])
            if f <= max_level + 1e-9:
                out.append((f, n, p["start"], p["end"]))
    return out


CARDINALITY_TERMS = ("item", "unit", "coupon")   # the payment-method terms are left out (README.md §3.6)


ORDER_PATH_TYPES = ("createOrder", "placeOrder")


def order_path(off, min_ms=0.2):
    """Services on the order path: an app container with D > min_ms in the production totals of createOrder or
    placeOrder (with its saga's handlers, which run as their follow-ups)."""
    return {c for t in ORDER_PATH_TYPES for c, d in (off.get(t, {}).get("D") or {}).items()
            if d and d > min_ms and parts.container_role(c) == "app" and not c.startswith("engine:")}


def cardinality_delta(fits, r_c=None, r_all=1.0, session=None, iso=None, min_t=2.0, terms=CARDINALITY_TERMS,
                      path=None):
    """{container: extra ms per order} of the session model's cardinalities over the isolation documents' from the
    factorial fits ({'cpu:<c>': {coef, se}}) for the app, DB and sidecar containers; a coefficient enters only
    when |coef| >= min_t x se, and only the `terms` (default: items, units, coupon). path: the order path's
    services (order_path); a container of another service is left out (with ~40 containers x 3 terms, 2-SE terms
    off the path are chance)."""
    session = session or SESSION_CARDINALITIES
    iso = iso or ISO_CARDINALITIES
    r_c = r_c or {}
    out = {}
    for key, f in fits.items():
        if not key.startswith("cpu:") or key in ("cpu:apps", "cpu:dbs", "cpu:sidecars"):
            continue
        c = key[4:]
        if parts.container_role(c) == "other":
            continue
        if path is not None and c.split("-")[0] not in path:
            continue
        d = 0.0
        for k, x in session.items():
            if k not in terms:
                continue
            coef, se = f["coef"].get(k, 0.0), f["se"].get(k, 0.0)
            if abs(coef) >= min_t * se and abs(coef) > 0:
                d += coef * (x - iso.get(k, 0.0))
        if d:
            out[c] = d * r_c.get(c, r_all)
    return out


def analyse(window, D, max_level=0.75, min_pred_ms=MIN_PRED_CORES, order_delta=None):
    """D: {type: {container short name: ms/request}} -> report. order_delta: {container: ms per order} added at the
    level's order rate (cardinality_delta)."""
    d = common.window_dir(window)
    cd = common.cpu_data(d)
    lv = levels(d, max_level)
    reqs = collections.defaultdict(collections.Counter)
    errs = collections.defaultdict(collections.Counter)
    for r in csv.DictReader(open(os.path.join(d, "requests.csv"))):
        reqs[r["phase"]][r["type"]] += 1
        if r["ok"] != "1":
            errs[r["phase"]][r["type"]] += 1
    meta = common.load_json(d, "meta.json")
    t0 = meta.get("t0", lv[0][2] if lv else 0)
    starts = collections.Counter()
    for r in csv.DictReader(open(os.path.join(d, "sessions.csv"))):
        t = t0 + float(r["t_arrival"])
        for f, n, s, e in lv:
            if s <= t < e:
                starts[n] += 1
    ph = common.phases(d)
    idle_iv = [(s + 5, e) for n, (s, e) in ph.items() if n in ("idle", "idle_end") and e - s > 10]
    keys = [k for k in cd.keys("misarch-") if not k.startswith("engine:")]
    limits = cpu_limits(d)
    rows = []
    for f, n, s, e in lv:
        dur = e - s
        rates = {t: c / dur for t, c in reqs[n].items()}
        rows.append({"level": f, "phase": n, "X": starts[n] / dur, "requestsPerS": sum(rates.values()),
                     "errors": sum(errs[n].values()), "rates": rates,
                     "ordersPerS": (rates.get("createOrder", 0.0) + rates.get("placeOrder", 0.0)) / 2,
                     "U": {common.short(k): cd.cores(k, s, e) for k in keys}})
    rep = {}
    xs = [r["X"] for r in rows]
    for k in keys:
        c = common.short(k)
        us = [r["U"][c] for r in rows]
        if any(u is None for u in us):
            continue
        ps0 = [sum(rate * D.get(t, {}).get(c, 0.0) for t, rate in r["rates"].items()) / 1000.0 for r in rows]
        dc = (order_delta or {}).get(c, 0.0)
        ps = [p + r["ordersPerS"] * dc / 1000.0 for p, r in zip(ps0, rows)]
        lim = limits.get(k)
        keep = [i for i in range(len(rows)) if lim is None or us[i] < CAPPED * lim]    # at the limit: throttled
        capped = [rows[i]["level"] for i in range(len(rows)) if i not in keep]
        xs_c, us_c, ps_c = [xs[i] for i in keep], [us[i] for i in keep], [ps[i] for i in keep]
        ps0_c = [ps0[i] for i in keep]
        idle = None
        if idle_iv:
            tt = sum(b - a for a, b in idle_iv)
            idle = sum(cd.usec(k, a, b) or 0 for a, b in idle_iv) / 1e6 / tt
        if max(ps or [0]) <= min_pred_ms or len(keep) < 2:
            u0, dd, r2 = fit(xs, us)
            rep[c] = {"method": "unmodelled", "U0": round(u0, 4), "D_msPerSession": round(1000 * dd, 3),
                      "R2": round(r2, 3)}
            continue
        k_, how, u0, dd, dp, r2 = scale(xs_c, us_c, ps_c, idle)
        k0 = scale(xs_c, us_c, ps0_c, idle)[0]
        rep[c] = {"k": round(k_, 3), "kNoCardinality": round(k0, 3), "cardinalityMsPerOrder": round(dc, 3),
                  "method": how, "limitCores": lim, "cappedLevels": capped, "U0": round(u0, 4), "D_msPerSession": round(1000 * dd, 3),
                  "isoD_msPerSession": round(1000 * dp, 3), "R2": round(r2, 3),
                  "U": [round(u, 4) for u in us], "P": [round(p, 4) for p in ps]}
    return {"window": os.path.basename(d), "maxLevel": max_level, "orderDelta": order_delta or {},
            "levels": [{k: v for k, v in r.items() if k not in ("U", "rates")} for r in rows],
            "containers": rep}


def demand_table(off, on, r_c, r_all, min_ms=MIN_MS):
    """{type: {container: ms/request}}: off totals, else on x r_c; only demands above min_ms (the significant
    rows only; the small ones are noise around 0, and negative ones would lower the prediction)."""
    D = {}
    for t in set(off) | set(on):
        if t in off:
            D[t] = {c: v for c, v in off[t]["D"].items() if v > min_ms}
        else:            # the trace pipeline (collector, Zipkin) only works in the instrumented configuration
            D[t] = {c: v * r_c.get(c, r_all) for c, v in on[t]["D"].items()
                    if v > min_ms and not c.startswith(TRACE_PIPELINE)}
    return D


def demands(off_dirs, on_dirs, min_ms=MIN_MS):
    off, on = {}, {}
    for x in off_dirs:
        off.update(parts.iso_totals(x)[0])
    for x in on_dirs:
        on.update(parts.iso_totals(x)[0])
    r_c, _, _, r_all = parts.overhead_ratios(off, on)
    return demand_table(off, on, r_c, r_all, min_ms)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="approx4_atload_w1")
    ap.add_argument("--off", default="approx4_off_w1,approx4_off_w2,approx4_off_w3")
    ap.add_argument("--on", default="approx4_on_w1,approx4_on_w2,approx4_on_w3")
    ap.add_argument("--factorial", default=os.path.join(common.RAW, "factorial.json"),
                    help="factorial.json (its primary fit) for the cardinality term; '' for none")
    ap.add_argument("--max-level", type=float, default=0.75,
                    help="highest level on the line (README.md §4.1: the analysis uses <= 0.75)")
    ap.add_argument("--out")
    a = ap.parse_args()
    off, on = {}, {}
    for x in a.off.split(","):
        if x:
            off.update(parts.iso_totals(common.window_dir(x))[0])
    for x in a.on.split(","):
        if x:
            on.update(parts.iso_totals(common.window_dir(x))[0])
    r_c, _, _, r_all = parts.overhead_ratios(off, on)
    D = demand_table(off, on, r_c, r_all)
    delta = None
    if a.factorial and os.path.exists(a.factorial):
        fj = json.load(open(a.factorial))
        delta = cardinality_delta(common.factorial_fits(fj), r_c, r_all, path=order_path(off))
    r = analyse(a.window, D, a.max_level, order_delta=delta)
    out = a.out or os.path.join(common.window_dir(a.window), "analysis", "atload.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump(r, open(out, "w"), indent=1)
    for lvl in r["levels"]:
        print(f"L{lvl['level']}: X {lvl['X']:.2f} sessions/s, {lvl['requestsPerS']:.1f} req/s, errors {lvl['errors']}")
    for c, v in sorted(r["containers"].items(), key=lambda kv: -kv[1].get("D_msPerSession", 0)):
        if v.get("D_msPerSession", 0) < 0.1:
            continue
        print(f"{c:24s} {v['method']:18s} k {v.get('k', float('nan')):6.3f} (no card. {v.get('kNoCardinality', float('nan')):6.3f}) D {v['D_msPerSession']:7.3f} "
              f"(iso {v.get('isoD_msPerSession', float('nan')):7.3f}) ms/session R2 {v['R2']}")
    print(out)


if __name__ == "__main__":
    main()

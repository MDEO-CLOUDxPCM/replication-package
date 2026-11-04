#!/usr/bin/env python3
"""Order-path factorial (README.md §3.6, block 4b): per-item and per-unit costs, coupon and payment-method
effects, stock-size check.

    factorial.py --fo approx4_fo_w1,approx4_fo_w2,approx4_fo_w3 --iso approx4_on_w2 [--out timing/raw/factorial.json]

A cell `i<items>q<qty>c<coupon><INV|PRE|CC>s<stock>` runs `foOrder.<cell>` (createOrder) and `foPlace.<cell>`
(placeOrder + saga) at 1/s each (Poisson, so their counts n_o, n_p differ by ~10 %). Per cell and per order
(one createOrder + one placeOrder with its saga):
- CPU per container: net cgroup CPU over the steady phase (baseline: median of the window's idle and `pre`
  phases; less the cell's segment offset of the container's role, common.segment_offsets) divided by the
  request mix: per order = CPU / (n_o D_o + n_p D_p) x (D_o + D_p), with D_o, D_p the isolation demands of
  createOrder and placeOrder in the `--iso` window (only their split between the two types is used);
- DB per service: pg_stat_statements exec ms and statements, each statement divided by the count of the type its
  operations belong to (createOrder's or placeOrder's request operations; mixed shapes by the mean count);
- latency p50 of foOrder and foPlace.
Each metric is fitted over the cells by ordinary least squares
    y = b0 + b_item (i - 1) + b_unit i (q - 1) + b_coupon c + b_PRE [PRE] + b_CC [CC] + b_s600 [s = 600]
(INVOICE, no coupon, stock 60, one item of one unit is the base). The 22 cells (gen_plans.fo_cells) for 7
coefficients; the residual standard deviation is reported as the noise level.

Fits: `fits` is ordinary least squares, `fitsRobust` a Huber M-estimate (k = 1.345 x the residuals' MAD scale,
iteratively reweighted; the SEs from the final weighted fit) of the same model; `primary` names the one used
downstream (parts.py, atload.py; common.factorial_fits). Default (README.md §3.6): --primary ols, all cells, the
Huber fit reported next to it (--primary robust down-weights a cell that a short host-side disturbance inflated by its
residual, without a regime rule). Per cell the gateway speed factor (speed.gateway_factor) is recorded (`speed`), not
used: dividing by it would bias the levels (README.md §4.2: no speed gate).
"""
import argparse
import csv
import json
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import parts  # noqa: E402
import queries  # noqa: E402
import speed  # noqa: E402

CELL = re.compile(r"^i(\d+)q(\d+)c(\d)(INV|PRE|CC)s(\d+)$")
COEFS = ("b0", "item", "unit", "coupon", "PRE", "CC", "s600")


def cell_params(cell):
    m = CELL.match(cell)
    if not m:
        return None
    i, q, c, pm, s = m.groups()
    return {"items": int(i), "qty": int(q), "coupon": int(c), "pay": pm, "stock": int(s)}


def design_row(p):
    return [1.0, p["items"] - 1, p["items"] * (p["qty"] - 1), p["coupon"], float(p["pay"] == "PRE"),
            float(p["pay"] == "CC"), float(p["stock"] == 600)]


def ols(X, y):
    """Least squares with the normal equations (pure Python); -> (coefficients, residual SD, standard errors)."""
    k = len(X[0])
    A = [[sum(x[i] * x[j] for x in X) for j in range(k)] for i in range(k)]
    b = [sum(x[i] * v for x, v in zip(X, y)) for i in range(k)]
    c = parts._solve(A, b)
    if c is None:
        return None, None, None
    res = [sum(a * xx for a, xx in zip(c, x)) - v for x, v in zip(X, y)]
    dof = max(1, len(y) - k)
    sd = (sum(r * r for r in res) / dof) ** 0.5
    inv_diag = [(parts._solve(A, [float(i == j) for j in range(k)]) or [0.0] * k)[i] for i in range(k)]
    return c, sd, [sd * max(0.0, v) ** 0.5 for v in inv_diag]


def huber(X, y, k=1.345, iters=50):
    """Huber M-estimate by iteratively reweighted least squares -> (coefficients, robust residual scale, SEs)."""
    w = [1.0] * len(y)
    c = sd = se = None
    for _ in range(iters):
        sw = [v ** 0.5 for v in w]
        c, sd, se = ols([[a * s_ for a in x] for x, s_ in zip(X, sw)], [v * s_ for v, s_ in zip(y, sw)])
        if c is None:
            return None, None, None
        res = [v - sum(a * xx for a, xx in zip(c, x)) for x, v in zip(X, y)]
        scale = 1.4826 * st.median(abs(r) for r in res) or 1e-9
        nw = [min(1.0, k * scale / abs(r)) if r else 1.0 for r in res]
        if max(abs(a - b_) for a, b_ in zip(nw, w)) < 1e-6:
            break
        w = nw
    return c, sd, se


def cell_data(d, mp, iso):
    d = common.window_dir(d)
    meta = common.load_json(d, "meta.json")
    ph = {p["name"]: (p["start"], p["end"]) for p in meta["phases"]}
    reqs = list(csv.DictReader(open(os.path.join(d, "requests.csv"))))
    cd = common.cpu_data(d)
    q = common.load_json(d, "analysis/queries.json") or queries.analyse_window(d, mp)
    ops_o = {o for o, _ in mp.request_ops("createOrder")}
    ops_p = {o for o, _ in mp.request_ops("placeOrder")}
    keys = [k for k in cd.keys("misarch-") if not k.startswith("engine:")]
    # baseline: median idle rate over the window's idle phases and all cells' `pre` phases (single pre phases
    # carry tails of the fill phase; the signal at 1 order/s is a few ms/s per container)
    quiet = [(s, e) for n, (s, e) in ph.items() if (n.endswith(":pre") or n in ("idle", "idle_end")) and e - s > 8]
    base_all = {}
    for k in keys:
        v = [x for x in (cd.cores(k, s + 1, e) for s, e in quiet) if x is not None]
        if v:
            base_all[k] = st.median(v)
    # the segment offset (common.segment_offsets): a cell touches createOrder's and placeOrder's services
    services = sorted({o["service"] for o in mp.ops.values()})
    touched = (common.touched_services(mp, "createOrder") or set()) | (common.touched_services(mp, "placeOrder") or set())
    out = {}
    for name, (s0, s1) in ph.items():
        if not name.endswith(":steady"):
            continue
        cell = name.split(":")[0]
        p = cell_params(cell)
        if p is None:
            continue
        offs = {}
        if common.offset_enabled():
            net = {}
            for k in keys:
                u = cd.usec(k, s0, s1)
                if u is not None and base_all.get(k) is not None:
                    net[common.short(k)] = u / 1e6 / (s1 - s0) - base_all[k]
            offs = common.segment_offsets(net, touched, services)
        rs = [r for r in reqs if r["phase"] == name]
        n_o = sum(r["type"] == f"foOrder.{cell}" and r["ok"] == "1" for r in rs)
        n_p = sum(r["type"] == f"foPlace.{cell}" and r["ok"] == "1" for r in rs)
        err = sum(r["ok"] != "1" for r in rs)
        lat_o = [float(r["latency_ms"]) for r in rs if r["type"] == f"foOrder.{cell}" and r["ok"] == "1"]
        lat_p = [float(r["latency_ms"]) for r in rs if r["type"] == f"foPlace.{cell}" and r["ok"] == "1"]
        gw = cd.cores(common.PREFIX + "gateway-1", s0, s1)
        gw_work = (n_o * iso.get("createOrder", {}).get("gateway", 0.0) +
                   n_p * iso.get("placeOrder", {}).get("gateway", 0.0)) / max(1e-9, s1 - s0)
        spd = speed.gateway_factor(gw * 1000 if gw is not None else None, gw_work)
        cpu = {}
        for k in keys:
            u = cd.usec(k, s0, s1)
            base = base_all.get(k)
            if u is None or base is None:
                continue
            net_ms = u / 1000 - base * (s1 - s0) * 1000
            c = common.short(k)
            role = common.offset_role(c, services)
            if role in offs:
                net_ms -= offs[role][0] * (s1 - s0) * 1000
            do, dp = iso.get("createOrder", {}).get(c, 0.0), iso.get("placeOrder", {}).get(c, 0.0)
            mix = n_o * do + n_p * dp
            cpu[c] = net_ms / mix * (do + dp) if mix > 0 and do + dp > 0.2 else net_ms / max(1, (n_o + n_p) / 2)
        db = {}
        seg = q["segments"].get(name, {})
        for x in seg.get("statements", []):
            ops = set(x.get("ops") or [])
            if x.get("background") or (x["kind"] != "tx" and not x.get("table")):
                continue
            n = n_o if ops and ops <= ops_o else (n_p if ops and ops <= ops_p else (n_o + n_p) / 2)
            e = db.setdefault(x["service"], {"execMs": 0.0, "statements": 0.0, "rows": 0.0})
            e["execMs"] += x["execMs"] / max(n, 1)
            e["statements"] += x["calls"] / max(n, 1)
            e["rows"] += x["rows"] / max(n, 1)
        out[cell] = {"params": p, "window": os.path.basename(d), "nOrder": n_o, "nPlace": n_p, "errors": err,
                     "latencyP50": {"createOrder": st.median(lat_o) if lat_o else None,
                                    "placeOrder": st.median(lat_p) if lat_p else None},
                     "cpuPerOrderMs": cpu, "db": db,
                     **({"segmentOffsets": {r_: {"msPerS": round(o * 1000, 4), "untouched": n_}
                                            for r_, (o, n_) in offs.items()}} if offs else {}),
                     "speed": round(spd, 4), "placementMsPerS": speed.placement(cd, s0, s1),
                     "reservation": reservation_stats(seg, n_p)}
    return out


def reservation_stats(seg, n_p):
    """inventory's FOR UPDATE SKIP LOCKED pick (the stock-size check): exec ms per call and per order."""
    calls = ex = 0.0
    for x in seg.get("statements", []):
        if x["service"] == "inventory" and x.get("lock"):
            calls += x["calls"]
            ex += x["execMs"]
    return {"calls": calls, "execMsPerCall": ex / calls if calls else None,
            "callsPerOrder": calls / n_p if n_p else None, "execMsPerOrder": ex / n_p if n_p else None}


def fit_all(cells, robust=False):
    """OLS (robust: Huber) of every metric over the cells."""
    names = sorted(cells)
    est = huber if robust else ols

    def cpu_of(n):
        return dict(cells[n]["cpuPerOrderMs"])
    X = [design_row(cells[c]["params"]) for c in names]
    metrics = {}

    def add(key, ys):
        if any(v is None for v in ys):
            return
        coef, sd, se = est(X, ys)
        if coef is not None:
            metrics[key] = {"coef": {k: round(v, 4) for k, v in zip(COEFS, coef)},
                            "se": {k: round(v, 4) for k, v in zip(COEFS, se)}, "residualSd": round(sd, 4),
                            "mean": round(st.mean(ys), 4)}
    cpus = {n: cpu_of(n) for n in names}
    conts = sorted({c for v in cpus.values() for c in v})
    apps = [c for c in conts if parts.container_role(c) == "app"]
    add("cpu:apps", [sum(cpus[n].get(c, 0) for c in apps) for n in names])
    add("cpu:dbs", [sum(v for c, v in cpus[n].items() if parts.container_role(c) == "db")
                    for n in names])
    add("cpu:sidecars", [sum(v for c, v in cpus[n].items()
                             if parts.container_role(c) in ("dapr", "ecs")) for n in names])
    for c in conts:
        ys = [cpus[n].get(c, 0.0) for n in names]
        if st.mean(ys) >= 0.5:
            add(f"cpu:{c}", ys)
    svcs = sorted({s for v in cells.values() for s in v["db"]})
    for s in svcs:
        add(f"dbExec:{s}", [cells[n]["db"].get(s, {}).get("execMs", 0.0) for n in names])
        add(f"statements:{s}", [cells[n]["db"].get(s, {}).get("statements", 0.0) for n in names])
    add("latency:createOrder", [cells[n]["latencyP50"]["createOrder"] for n in names])
    add("latency:placeOrder", [cells[n]["latencyP50"]["placeOrder"] for n in names])
    add("reservation:execMsPerCall", [cells[n]["reservation"]["execMsPerCall"] for n in names])
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fo", default="approx4_fo_w1,approx4_fo_w2,approx4_fo_w3")
    ap.add_argument("--iso", default="approx4_on_w2", help="window with createOrder and placeOrder isolation segments")
    ap.add_argument("--out", default=os.path.join(common.RAW, "factorial.json"))
    ap.add_argument("--primary", choices=("ols", "robust"), default="ols",
                    help="the fit used downstream (README.md §3.6)")
    a = ap.parse_args()
    mp = queries.Mapping()
    iso_t, _ = parts.iso_totals(common.window_dir(a.iso))
    iso = {t: v["D"] for t, v in iso_t.items() if t in ("createOrder", "placeOrder")}
    cells = {}
    for w in a.fo.split(","):
        cells.update(cell_data(w, mp, iso))
    r = {"generatedBy": "timing/analysis/factorial.py", "windows": a.fo.split(","), "iso": a.iso,
         "model": "y = b0 + item (i-1) + unit i(q-1) + coupon c + PRE + CC + s600 (base: INVOICE, no coupon, s60, i1q1)",
         "primary": {"ols": "fits", "robust": "fitsRobust"}[a.primary],
         "fitNote": "fits: OLS; fitsRobust: Huber M-estimate; `primary` is used downstream. Cell `speed` recorded, "
                    "not used.",
         "cells": cells, "fits": fit_all(cells), "fitsRobust": fit_all(cells, robust=True)}
    json.dump(r, open(a.out, "w"), indent=1)
    print("speed per cell:", {c: v["speed"] for c, v in sorted(cells.items())})
    for k, v in r[r["primary"]].items():
        print(f"{k:28s} mean {v['mean']:8.3f} sd {v['residualSd']:6.3f} " +
              " ".join(f"{c}={x:+.2f}({v['se'][c]:.2f})" for c, x in v["coef"].items()))
    print(a.out)


if __name__ == "__main__":
    main()

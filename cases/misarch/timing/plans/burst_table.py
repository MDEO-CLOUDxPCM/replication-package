#!/usr/bin/env python3
"""Burst table of the warm-up bursts (harness/bursts.py): which types need a warm-up burst, how many requests, at most
how fast, and on which apps. Computed from the windows ON and OFF below (approx2_*, measured without bursts; not in
this package), so plans/approx3/bursts.json is a plan input that cannot be regenerated from the package's data
(README.md §4.1).

    $PY burst_table.py [--out plans/approx3/bursts.json] [--n 5000] [--threshold 0.05]

- need: the type's gc+jit share > --threshold (all apps of its steady segment, net of the idle baseline and
  without instrumentation; analysis/buckets.json of the ON windows; `gcJitShareV2`). The jit part alone is reported too
  (buckets.yaml's jit bucket; `jitShareV2`).
- n: --n requests, capped where the data or a pool limits a type (N_CAP).
- util: per CPU-limited container, the fraction of its limit per request/s (off totals D, cgroup; the OFF windows,
  mech windows for the block-6 types, createOrder + placeOrder for a factorial cell); maxRate = U_TYPE / the largest.
- apps: the JVM containers with D >= max(0.5 ms, 5 % of the type's largest app D) per request (their restart makes the type cold again).
Run with the calibration venv (analysis/parts.py -> calibration's analyze_iso).
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(T, "analysis"))
import common  # noqa: E402
import parts  # noqa: E402

U_TYPE = 0.5                 # a single burst: at most this share of its busiest limited container
MAX_RATE = 60.0              # requests/s per type (client side)
N_CAP = {"return.createReturn": 400,          # returnable pool (run.py prep --n 400: delivered, unreturned orders)
         "registration": 1500,                # Keycloak users, deleted again by the reset's kc_clean (8 at a time)
         "media.uploadMedia": 2000,           # objects stay in RustFS (not reset)
         "login": 2000,
         "shipment.archiveShipmentMethod": 1000}     # archives the methods the generator itself created
FO_N = 1000                  # factorial cells: per payment method one cell (stock 60 x 60 variants after run.py stock)
FO_BURST_CELLS = ["i1q1c1INVs60", "i1q1c1PREs60", "i1q1c1CCs60"]   # the saga branches and the coupon path
ON = ["approx2_on_w1", "approx2_on_w2", "approx2_on_w3", "approx2_mech_on_w2", "approx2_fo_w1", "approx2_fo_w2"]
OFF = ["approx2_off_w1", "approx2_off_w2", "approx2_off_w3", "approx2_mech_off_w1", "approx2_mech_on_w1"]
JVM_EXCLUDE = ("gateway", "experiment-config", "media-minio", "simulation-rabbitmq", "dapr-redis", "placement",
               "otel-collector", "zipkin-all-in-one")


def shares():
    out = {}
    for w in ON:
        d = common.window_dir(w)
        b = common.load_json(d, "analysis/buckets.json")
        if not b:
            continue
        for seg, cs in b["segments"].items():
            if not seg.endswith(":steady"):
                continue
            t = seg.split(":")[0]
            net = sum(v["netTotalMs"] for c, v in cs.items() if c != "_all")
            ins = sum(v["netMs"].get("instrumentation", 0) for c, v in cs.items() if c != "_all")
            gj = sum(v["netMs"].get("gc+jit", 0) + v["netMs"].get("jit", 0) + v["netMs"].get("gc", 0)
                     for c, v in cs.items() if c != "_all")
            out[t] = round(gj / (net - ins), 4) if net - ins > 0 else None
    return out


def jit_shares():
    """jit only, from the folded stacks with buckets.yaml's rules (not in the windows' cached buckets.json)."""
    import profile_buckets as pb
    out = {}
    for w in ON:
        r = pb.analyse_window(common.window_dir(w), top=0)
        for seg, cs in r["segments"].items():
            if seg.endswith(":steady"):
                out[seg.split(":")[0]] = cs["_all"].get("jitShare")
    return out


def totals():
    D, lim = {}, {}
    for w in OFF:
        d = common.window_dir(w)
        if not os.path.isdir(d):
            continue
        t, _ = parts.iso_totals(d)
        for k, v in t.items():
            D.setdefault(k, v["D"])
        wj = common.load_json(d, "window.json") or {}
        for k, v in (wj.get("limits") or {}).items():
            cm = (v or {}).get("cpu.max")
            if cm and not cm.startswith("max"):
                q, p = cm.split()
                lim[common.short(k)] = int(q) / int(p)
    return D, lim


def entry(t, Dt, lim, share, jit, n, threshold):
    util = {c: round(Dt[c] / 1000 / lim[c], 6) for c in Dt if c in lim and Dt[c] and Dt[c] > 0}
    umax = max(util.values()) if util else 0.0
    jv = {c: v for c, v in Dt.items() if v and parts.container_role(c) == "app" and c not in JVM_EXCLUDE
          and not c.startswith("engine:")}
    floor = max(0.5, 0.05 * max(jv.values(), default=0))     # off-path drift of rare types is up to ~1 ms
    apps = sorted(c for c, v in jv.items() if v >= floor) + (["keycloak"] if Dt.get("keycloak", 0) >= 0.5 else [])
    return {"need": share is not None and share > threshold, "gcJitShareV2": share, "jitShareV2": jit,
            "n": n, "maxRate": round(min(MAX_RATE, U_TYPE / umax) if umax > 0 else MAX_RATE, 3),
            "util": util, "apps": apps}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "approx3", "bursts.json"))
    ap.add_argument("--n", type=int, default=5000)
    ap.add_argument("--threshold", type=float, default=0.05)
    a = ap.parse_args()
    sh, js = shares(), jit_shares()
    D, lim = totals()
    tab = {}
    for t, s in sorted(sh.items()):
        kind, _, cell = t.partition(".")
        if t in D:
            Dt = D[t]
        elif t.split(".")[0] in D and t.endswith((".hot", ".cold")):
            Dt = D[t.split(".")[0]]
        elif t.startswith("i") and "q" in t:                    # factorial cells: FO_BURST_CELLS below
            continue
        else:
            print(f"no off totals for {t}: skipped")
            continue
        tab[t] = entry(t, Dt, lim, s, js.get(t), N_CAP.get(t, a.n), a.threshold)
    # factorial: one cell per payment method (with coupon), createOrder + placeOrder totals on foOrder, the cart
    # fill's on foCart; need from the largest gc+jit share of the measured cells
    fo = [v for t, v in sh.items() if t.startswith("i") and "q" in t and v is not None]
    Dfo = {c: D["createOrder"].get(c, 0) + D["placeOrder"].get(c, 0) for c in set(D["createOrder"]) | set(D["placeOrder"])}
    for cell in FO_BURST_CELLS:
        for k in ("foCart", "foOrder", "foPlace"):
            e = entry(f"{k}.{cell}", Dfo, lim, max(fo) if fo else None, None, FO_N, a.threshold)
            if k == "foCart":
                e["util"] = {c: round(D["createShoppingcartItem"].get(c, 0) / 1000 / lim[c], 6)
                             for c in D["createShoppingcartItem"] if c in lim}
                e["need"] = False          # a member of the cell's group, not a burst of its own
            elif k == "foPlace":
                e["util"], e["need"] = {}, False   # the cell's CPU is all on foOrder (createOrder + placeOrder)
            tab[f"{k}.{cell}"] = e
    # types not in the ON/OFF windows, with the totals of the type they vary (caller cache, README.md §4.1: createOrder.hot)
    for t, base in (("createOrder.hot", "createOrder"),):
        if base in tab:
            tab[t] = dict(tab[base], gcJitShareV2=None, jitShareV2=None, needFrom=base)
    out = {"source": {"shares": ON, "totals": OFF}, "threshold": a.threshold, "uMax": 0.6, "uType": U_TYPE,
           "settleS": 30, "nDefault": a.n, "limits": lim, "types": tab}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(out, open(a.out, "w"), indent=1)
    need = [t for t, e in tab.items() if e["need"]]
    print(f"{a.out}: {len(tab)} types, {len(need)} need a burst; not: {[t for t, e in tab.items() if not e['need']]}")


if __name__ == "__main__":
    main()

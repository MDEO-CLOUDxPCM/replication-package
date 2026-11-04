#!/usr/bin/env python3
"""Isolation plans for the timing campaign (README.md §4) in loadgen.py's plan format, grouped into windows of at
most 30 min (measure.py refuses longer plans), plus the manifest that run_campaign.sh walks.

    gen_plans.py pilot  [--out DIR]                 block 1: each request alone 20 s at 3 rates (windows <= 30 min)
    gen_plans.py pilot-rates --iso ISO.json --windows D1,D2 [--out rates.json]
                                                    pilot analysis (analyze_iso.py over the pilot windows) -> rates
    gen_plans.py approx3 [--rates rates.json] [--out DIR]  the campaign's plans (plans/approx3, run as windows
                                                    approx4_*): blocks 2 (off totals, all types), 3 (on), 4b (the
                                                    factorial, 3 windows), 5 (latency), 6 (mechanisms: local copies,
                                                    entity cache incl. the shared-key cache, caller-side cache),
                                                    7 (at-load sessions); per window `burstTypes` (warm-up bursts,
                                                    burst_table.py -> bursts.json) (README.md §4.1)

Data growth: within every window the types that create rows (CREATING) run after all other types,
with shorter segments (warm 15 s, steady 45 s, at their rate); warm_timing.json creates no rows. Row counts per
window: window.py's volume_before.json / volume_after.json.

Request types: the 36 of workload/sessions.json plus products.anon / product.anon (timing/requests/reqs.py), checked
against A's operations (domain/misarch-domain.json: every type's plan operations must exist). Rates: from rates.json
(pilot) when given, else defaults (R2_RATES where it has the type).

Window plan = loadgen plan {"name", "phases"} plus metadata keys loadgen ignores: "config" (off | on), "block",
"rateLevel" (mid | pilot | factorial | latency | sessions), "types", "prep" (commands to run before the window, outside it), "durationS".
manifest.json lists the windows in run order.
"""
import argparse
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TIMING = os.path.dirname(HERE)
ROOT = os.path.dirname(TIMING)          # the case's root (cases/misarch)
MAX_PLAN_S = 1700          # measure.py: plan + settle + 60 s <= 1800 s
IDLE, IDLE_END = 60, 30
PRE, WARM, STEADY = 15, 20, 75

# canonical order inside a window; the order chain (cart -> order -> place -> tracking) must stay together and in
# this order (maintain.py empties carts between windows; placeOrder takes createOrder's orders)
ORDER = ["products", "products.anon", "product", "product.anon", "users", "address", "paymentInformations",
         "shipmentMethods", "notifications", "wishlistView", "login", "registration",
         "createShoppingcartItem", "createOrder", "placeOrder", "orderTracking", "return.createReturn",
         "createReview", "addToWishlist", "wishlist.createWishlist", "user.updateUser", "address.createUserAddress",
         "payment.createCreditCardPaymentInformation", "discount.registerCoupon",
         "adminUpdateProduct", "adminNewPrice", "adminCreateVariant", "adminCreateProduct", "catalog.updateProductVariant",
         "catalog.createCategory", "inventory.createProductItemBatch", "media.uploadMedia", "discount.createDiscount",
         "discount.createCoupon", "tax.createTaxRate", "tax.createTaxRateVersion", "shipment.createShipmentMethod",
         "address.createVendorAddress"]
CHAIN = ["createShoppingcartItem", "createOrder", "placeOrder"]   # orderTracking reads the placed pool (any order)

# default isolation rates (the calibration's isolation plans, calibration/): busiest limited container 8-25 % of its
# limit on 8 vCPU. Others: defaults by kind. Used where rates.json has no rate, and for the pilot plans.
R2_RATES = {"login": 10, "products": 6, "product": 5, "users": 6, "address": 5, "shipmentMethods": 5,
            "paymentInformations": 6, "createShoppingcartItem": 8, "createOrder": 3, "placeOrder": 2.7,
            "orderTracking": 5, "wishlistView": 5, "addToWishlist": 6, "createReview": 6, "adminUpdateProduct": 4,
            "adminNewPrice": 3, "adminCreateVariant": 1.5, "adminCreateProduct": 1.5}
DEFAULT_QUERY, DEFAULT_MUTATION, DEFAULT_ADMIN = 5.0, 4.0, 2.0
# upper bounds from pools / data (per steady segment): factorial buyers, returnable orders, registration coupons
CAPS = {"return.createReturn": 3.0, "discount.registerCoupon": 4.0, "registration": 3.0}
DRAIN = {"placeOrder": 45, "adminCreateProduct": 35, "adminCreateVariant": 30, "adminNewPrice": 25, "registration": 30,
         "return.createReturn": 40, "createOrder": 20, "catalog.createCategory": 20, "shipment.createShipmentMethod": 20,
         "address.createVendorAddress": 20, "tax.createTaxRate": 20, "tax.createTaxRateVersion": 20,
         "discount.createCoupon": 20, "media.uploadMedia": 20, "inventory.createProductItemBatch": 20,
         "catalog.updateProductVariant": 20, "user.updateUser": 25, "address.createUserAddress": 25,
         "payment.createCreditCardPaymentInformation": 20, "wishlist.createWishlist": 20}
QUERIES = {"products", "products.anon", "product", "product.anon", "users", "address", "paymentInformations",
           "shipmentMethods", "notifications", "wishlistView", "orderTracking", "login"}
# types that insert rows (orders, carts, entities, versions, join rows, users); everything else reads or updates
CREATING = {"registration", "createShoppingcartItem", "createOrder", "placeOrder", "return.createReturn", "createReview",
            "addToWishlist", "wishlist.createWishlist", "address.createUserAddress",
            "payment.createCreditCardPaymentInformation", "discount.registerCoupon", "adminNewPrice",
            "adminCreateVariant", "adminCreateProduct", "catalog.createCategory", "inventory.createProductItemBatch",
            "media.uploadMedia", "discount.createDiscount", "discount.createCoupon", "tax.createTaxRate",
            "tax.createTaxRateVersion", "shipment.createShipmentMethod", "address.createVendorAddress"}
CREATE_WARM, CREATE_STEADY = 15, 45    # creating types outside the order chain: as few creations as needed


def reads_first(types):
    """Window order: the non-creating types first, then the creating ones (each group in ORDER's order)."""
    return [t for t in types if t not in CREATING] + [t for t in types if t in CREATING]


def seg_times(t, steady):
    if t in CREATING and t not in CHAIN:
        return CREATE_WARM, min(steady, CREATE_STEADY)
    return WARM, steady


# prep commands (outside windows); run_campaign.sh runs them in order, in timing/ (campaign.py: bash -c, cwd timing/),
# so the paths are relative to timing/ and the plans work in any checkout
PY = "calibration/.venv/bin/python"
PREP_MAINTAIN = f"{PY} calibration/scripts/maintain.py --stack kotlin"
PREP_POOLS = f"{PY} requests/run.py prep --n 400"
PREP_STOCK = f"{PY} requests/run.py stock"
PREP_CLEANUP = f"{PY} requests/run.py cleanup"
FO_RATE, FO_FILL, FO_DRAIN = 1.0, 20, 45
FO_BUYERS = 150


def types_all():
    sys.path.insert(0, os.path.join(TIMING, "requests"))
    try:
        import reqs
        names = list(reqs.REQUESTS)
    except Exception:          # loadgen import needs docker; the names are fixed anyway
        names = list(ORDER)
    missing = set(names) ^ set(ORDER)
    if missing:
        raise SystemExit(f"ORDER and reqs.REQUESTS differ: {missing}")
    return [t for t in ORDER if t in names]


def check_against_domain():
    """Every request of the session model names operations of A's extraction."""
    dom = json.load(open(os.path.join(ROOT, "domain", "misarch-domain.json")))
    ops = {o["id"] for o in dom["operations"]}
    model = json.load(open(os.path.join(ROOT, "workload", "sessions.json")))
    bad = {r: [o for o in x["operations"] if o not in ops] for r, x in model["requests"].items()}
    bad = {k: v for k, v in bad.items() if v}
    if bad:
        raise SystemExit(f"session requests with operations unknown to A: {bad}")
    stale = [m for m in dom["msaMapping"]["operations"] for o in m["ops"] if o not in ops]
    return len(model["requests"]), len(ops), stale


def default_rate(t):
    if t in R2_RATES:
        return float(R2_RATES[t])
    base = t.replace(".anon", "")
    if base in R2_RATES:
        return float(R2_RATES[base])
    if t in QUERIES:
        return DEFAULT_QUERY
    if t.split(".")[0] in ("catalog", "inventory", "media", "discount", "tax", "shipment") or t == "address.createVendorAddress":
        return DEFAULT_ADMIN if t != "discount.registerCoupon" else DEFAULT_MUTATION
    return DEFAULT_MUTATION


def rates_for(rates_file, level):
    r = json.load(open(rates_file))["rates"] if rates_file else {}
    out = {}
    for t in types_all():
        if t in r and r[t].get(level):
            v = r[t][level]
        else:
            v = default_rate(t) if level == "mid" else default_rate(t) / 5
        out[t] = round(min(v, CAPS.get(t, 1e9)), 3)
    return out


def segment(t, rate, steady=STEADY):
    warm, steady = seg_times(t, steady)
    return [{"name": f"{t}:pre", "duration": PRE, "rates": {}},
            {"name": f"{t}:warm", "duration": warm, "rates": {t: rate}},
            {"name": f"{t}:steady", "duration": steady, "rates": {t: rate}},
            {"name": f"{t}:drain", "duration": DRAIN.get(t, 15 if t in QUERIES else 20), "rates": {}}]


def seg_len(t, steady=STEADY):
    warm, steady = seg_times(t, steady)
    return PRE + warm + steady + DRAIN.get(t, 15 if t in QUERIES else 20)


def prep_for(types):
    p = [PREP_MAINTAIN]
    if "return.createReturn" in types or "createReview" in types:
        p.append(PREP_POOLS)
    if "shipment.createShipmentMethod" in types or "shipmentMethods" in types:
        p.append(PREP_CLEANUP)
    return p


def pack_blocks(types):
    """Types -> blocks; the order chain is one block (kept in one window, in order)."""
    blocks, i = [], 0
    while i < len(types):
        t = types[i]
        if t in CHAIN:
            ch = [x for x in CHAIN if x in types]
            blocks.append(ch)
            i += len(ch)
        else:
            blocks.append([t])
            i += 1
    return blocks


def pack(types, steady):
    """Windows <= MAX_PLAN_S, balanced."""
    blocks = pack_blocks(types)
    return balance(blocks, [sum(seg_len(t, steady) for t in b) for b in blocks], IDLE + IDLE_END)


def balance(blocks, lens, overhead, limit=MAX_PLAN_S):
    """Fewest windows <= limit (greedy, order kept), then the smallest capacity that still gives that many windows,
    so the windows come out about equally long instead of leaving a short last one."""
    def greedy(cap):
        wins, cur, dur = [], [], overhead
        for b, d in zip(blocks, lens):
            if cur and dur + d > cap:
                wins.append(cur)
                cur, dur = [], overhead
            cur += b
            dur += d
        return wins + ([cur] if cur else [])
    n = len(greedy(limit))
    lo, hi = overhead + max(lens), limit
    while lo < hi:
        mid = (lo + hi) // 2
        if len(greedy(mid)) <= n:
            hi = mid
        else:
            lo = mid + 1
    return greedy(lo)


def window_plan(name, types, rates, steady, config, block, level):
    phases = [{"name": "idle", "duration": IDLE, "rates": {}}]
    for t in types:
        phases += segment(t, rates[t], steady)
    phases.append({"name": "idle_end", "duration": IDLE_END, "rates": {}})
    return {"name": name, "config": config, "block": block, "rateLevel": level, "types": types, "prep": prep_for(types),
            "durationS": sum(p["duration"] for p in phases), "phases": phases}


def fo_window(name, cells, config, rate=FO_RATE):
    sys.path.insert(0, os.path.join(TIMING, "requests"))
    rate = min(rate, FO_BUYERS / (WARM + STEADY + 10))
    kits = math.ceil(rate * (WARM + STEADY) * 1.15 + 5)
    phases = [{"name": "idle", "duration": IDLE, "rates": {}}]
    for c in cells:
        phases += [{"name": f"{c}:fill", "duration": FO_FILL, "rates": {f"foCart.{c}": round(kits / FO_FILL, 3)},
                    "deterministic": True},
                   {"name": f"{c}:pre", "duration": PRE, "rates": {}},
                   {"name": f"{c}:warm", "duration": WARM, "rates": {f"foOrder.{c}": rate, f"foPlace.{c}": rate}},
                   {"name": f"{c}:steady", "duration": STEADY, "rates": {f"foOrder.{c}": rate, f"foPlace.{c}": rate}},
                   {"name": f"{c}:drain", "duration": FO_DRAIN, "rates": {}}]
    phases.append({"name": "idle_end", "duration": IDLE_END, "rates": {}})
    return {"name": name, "config": config, "block": "4b", "rateLevel": "factorial", "cells": cells,
            "prep": [PREP_MAINTAIN, PREP_STOCK], "durationS": sum(p["duration"] for p in phases), "phases": phases}


def half_fraction():
    """Per (items, qty) 3 cells, coupon alternating, every payment method once, plus two INVOICE cells at 600 stock
    items per variant."""
    import itertools
    items, qty, pays = (1, 3), (1, 3), ("INV", "PRE", "CC")
    cells = []
    for k, (i, q) in enumerate(itertools.product(items, qty)):
        for j, p in enumerate(pays):
            cells.append(f"i{i}q{q}c{(j + k) % 2}{p}s60")
    return cells + ["i1q1c0INVs600", "i3q3c0INVs600"]


def fo_cells():
    """The factorial's cells: the half fraction plus, for every PREPAYMENT and CREDIT_CARD cell, its twin with the
    coupon flipped (so each of the two methods has all 8 (items, qty, coupon) combinations, INVOICE keeps its 4 + the 2
    stock cells): 22 cells, interleaved by payment method so that every window holds all three (README.md §3.6)."""
    base = half_fraction()
    twins = []
    for c in base:
        p = re.match(r"^i(\d)q(\d)c(\d)(PRE|CC)s60$", c)
        if p:
            twins.append(f"i{p.group(1)}q{p.group(2)}c{1 - int(p.group(3))}{p.group(4)}s60")
    cells = base + twins
    by = {m: [c for c in cells if re.search(m + "s", c)] for m in ("PRE", "CC", "INV")}
    out = []
    while any(by.values()):
        for m in ("PRE", "CC", "INV"):
            if by[m]:
                out.append(by[m].pop(0))
    return out


def fo_windows(prefix, config, cells):
    seg = FO_FILL + PRE + WARM + STEADY + FO_DRAIN
    wins = balance([[c] for c in cells], [seg] * len(cells), IDLE + IDLE_END)
    return [fo_window(f"{prefix}_w{k + 1}", w, config) for k, w in enumerate(wins)]


def latency_plan(types):
    """Block 5 (composition, latency at low load): every type 100 requests, deterministic 4/s (one request at a time
    as long as it answers within 250 ms: a closed loop of one user, approximately)."""
    phases = [{"name": "idle", "duration": IDLE, "rates": {}}]
    for t in types:
        phases += [{"name": f"{t}:pre", "duration": 5, "rates": {}},
                   {"name": f"{t}:steady", "duration": 25, "rates": {t: 4.0}, "deterministic": True},
                   {"name": f"{t}:drain", "duration": 5, "rates": {}}]
    phases.append({"name": "idle_end", "duration": IDLE_END, "rates": {}})
    return {"name": "latency_w1", "config": "on", "block": 5, "rateLevel": "latency", "types": types,
            "prep": prep_for(types), "durationS": sum(p["duration"] for p in phases), "phases": phases}


ATLOAD_LEVELS = "0.25,0.5,0.75,1,1.25,1.5"     # x the shopping mix's design load (88.4 sessions/s)


def atload_plan(levels=ATLOAD_LEVELS, mix="shopping"):
    """Block 7: the session workload (sessiongen.py) on today's cut, 6 levels x (40 s transition + 150 s steady)."""
    sys.path.insert(0, TIMING)
    import sessiongen
    ns = argparse.Namespace(workload="realistic", levels=levels, mix=mix, trans=40, steady=150, profile="steady",
                            duration=None, scale=1.0, sessions=None, no_admin=False, tail=60)
    p = sessiongen.make_plan(ns)
    p.update(name="atload_w1", config="off", block=7, rateLevel="sessions", types=[],
             prep=[PREP_MAINTAIN, PREP_POOLS], durationS=sum(x["duration"] for x in p["phases"]))
    return p


# ---- block 6: local copies and response caches on today's cut (README.md §4.1). misarch-kotlin `timing-mechanisms`
# images for catalog, shipment, order (README.md §2.1), switches per window (timing-up.sh mech). Rates: the base
# type's mid rate (rates.json); the copy-writing admin operations at the low rate, and a warm-up without creating
# types (warm_mech.json), so that the tables they grow stay bounded. Row counts per window: volume_before/after.json.
MECH_CACHE = ["orderTracking.hot", "orderTracking.cold", "wishlistView.hot", "wishlistView.cold"]
MECH_COPY_WRITES = ["discount.createDiscount", "discount.updateDiscount", "discount.createCoupon", "adminCreateProduct",
                    "adminUpdateProduct", "adminCreateVariant", "adminNewPrice", "shipment.createShipmentMethod",
                    "shipment.archiveShipmentMethod"]
MECH_BASE = {"orderTracking.hot": "orderTracking", "orderTracking.cold": "orderTracking",
             "wishlistView.hot": "wishlistView", "wishlistView.cold": "wishlistView",
             "discount.updateDiscount": "discount.createDiscount",
             "shipment.archiveShipmentMethod": "shipment.createShipmentMethod"}
MECH_CW_PRE, MECH_CW_WARM, MECH_CW_STEADY = 10, 15, 45      # copy writes: shorter segments (low-rate admin ops)
MECH_FILL = 45
MECH_WL_FILL = 35
MECH_ARCHIVE_SHARE = 0.9    # archive a bit slower than create: the archive segment takes the methods created before
MECH_OFF = {"localCopies": False, "entityCache": False, "cacheTtlS": 60}
MECH_ON = {"localCopies": True, "entityCache": True, "cacheTtlS": 60}


def mech_window(name, config, mech, with_copy_writes, mid, low):
    """createOrder (copy read vs remote calls) after an unmeasured cart fill, the cache phases (hot = all hits,
    cold = all misses), and optionally the copy-writing admin operations."""
    rate = {t: mid[MECH_BASE.get(t, t)] for t in ["createOrder"] + MECH_CACHE}
    rate.update({t: low[MECH_BASE.get(t, t)] for t in MECH_COPY_WRITES})
    rate["shipment.archiveShipmentMethod"] = round(rate["shipment.archiveShipmentMethod"] * MECH_ARCHIVE_SHARE, 3)
    carts = math.ceil(mid["createOrder"] * (WARM + STEADY) * 1.1 + 10)
    phases = [{"name": "idle", "duration": IDLE, "rates": {}},
              {"name": "createShoppingcartItem:fill", "duration": MECH_FILL,
               "rates": {"createShoppingcartItem": round(carts / MECH_FILL, 3)}}]
    phases += segment("createOrder", rate["createOrder"])
    # the cold phases need a key not used before in the window for every request: orderTracking takes the orders
    # createOrder just created; the wishlists come from an unmeasured fill (after a data reset the pools hold only
    # the baseline's 200 placed orders and 80 wishlists)
    wl = math.ceil(rate["wishlistView.cold"] * (WARM + STEADY) * 1.1 + 20)
    for t in MECH_CACHE:
        if t == "wishlistView.hot":
            phases.append({"name": "wishlist.createWishlist:fill", "duration": MECH_WL_FILL,
                           "rates": {"wishlist.createWishlist": round(wl / MECH_WL_FILL, 3)}})
        phases += segment(t, rate[t])
    types = ["createOrder"] + MECH_CACHE
    if with_copy_writes:
        for t in MECH_COPY_WRITES:
            phases += [{"name": f"{t}:pre", "duration": MECH_CW_PRE, "rates": {}},
                       {"name": f"{t}:warm", "duration": MECH_CW_WARM, "rates": {t: rate[t]}},
                       {"name": f"{t}:steady", "duration": MECH_CW_STEADY, "rates": {t: rate[t]}},
                       {"name": f"{t}:drain", "duration": DRAIN.get(t, 20), "rates": {}}]
        types += MECH_COPY_WRITES
    phases.append({"name": "idle_end", "duration": IDLE_END, "rates": {}})
    prep = [PREP_MAINTAIN] + ([PREP_CLEANUP] if with_copy_writes else [])
    return {"name": name, "config": config, "block": 6, "rateLevel": "mid", "types": types,
            "baseTypes": {t: MECH_BASE.get(t, t) for t in types}, "mechanisms": dict(mech), "prep": prep,
            "warm": "warm_mech.json",
            "durationS": sum(p["duration"] for p in phases), "phases": phases}


def mech_windows(mid, low):
    """off totals with the switches off (reference) and on; on shares with the switches on (the switches-off shares
    are block 3's: same code paths)."""
    return [mech_window("mech_off_w1", "off", MECH_OFF, False, mid, low),
            mech_window("mech_on_w1", "off", MECH_ON, True, mid, low),
            mech_window("mech_on_w2", "on", MECH_ON, True, mid, low)]


def mech_warm_plan(mid):
    """Warm-up of the block-6 windows (not measured): the window's request paths at 1/3 of the mid rate, and the
    copy-writing paths only through updates (no rows are created)."""
    r = {t: round(mid[MECH_BASE.get(t, t)] / 3, 3) for t in
         ["createShoppingcartItem", "createOrder", "orderTracking.cold", "wishlistView.cold"]}
    r.update({"adminUpdateProduct": 1.0, "discount.updateDiscount": 1.0})
    return {"name": "warm_mech", "config": "any", "block": "warm", "rateLevel": "warm",
            "phases": [{"name": "warm", "duration": 240, "rates": r}]}


def warm_plan(rates):
    """warm_all equivalent (before every window, not measured): every non-creating type at 1/3 of its rate for
    240 s (no rows are created; the creating types warm up in their own warm phase)."""
    return {"name": "warm_timing", "config": "any", "block": "warm", "rateLevel": "warm",
            "phases": [{"name": "warm", "duration": 240,
                        "rates": {t: round(r / 3, 3) for t, r in rates.items() if t not in CREATING}}]}


def write(out, plans, manifest_extra):
    os.makedirs(out, exist_ok=True)
    man = []
    for p in plans:
        fn = f"{p['name']}.json"
        if p["durationS"] > MAX_PLAN_S:
            raise SystemExit(f"{fn}: {p['durationS']} s > {MAX_PLAN_S}")
        json.dump(p, open(os.path.join(out, fn), "w"), indent=1)
        man.append({"plan": fn, "name": p["name"], "config": p["config"], "block": p["block"],
                    "rateLevel": p["rateLevel"], "durationS": p["durationS"], "prep": p["prep"],
                    "warm": p.get("warm", "warm_timing.json")})
        if "mechanisms" in p:
            man[-1]["mechanisms"] = p["mechanisms"]
        if "burstTypes" in p:
            man[-1]["burstTypes"] = p["burstTypes"]
        if "sampler" in p:
            man[-1]["sampler"] = p["sampler"]
        if "burstScale" in p:
            man[-1]["burstScale"] = p["burstScale"]
    m = dict(manifest_extra, windows=man, totalWindowS=sum(x["durationS"] for x in man))
    json.dump(m, open(os.path.join(out, "manifest.json"), "w"), indent=1)
    for x in man:
        mech = x.get("mechanisms")
        print(f"  {x['plan']:28s} {x['config']:4s} block {str(x['block']):5s} {x['durationS']:5.0f} s"
              + (f"  copies {'on' if mech['localCopies'] else 'off'}, cache {'on' if mech['entityCache'] else 'off'}"
                 f"{' shared' if mech.get('sharedCache') else ''}, caller cache {mech.get('callerCache') or 'off'}"
                 if mech else ""))
    print(f"{out}: {len(man)} windows, {m['totalWindowS'] / 3600:.2f} h of windows (+ warm-ups and gaps)")


def cmd_pilot(a):
    """Block 1: every type alone, 20 s steady at 3 rates (segments <type>@<rate>, which analyze_iso.py understands)."""
    types = types_all()
    rates = rates_for(None, "mid")
    mult = [float(x) for x in a.mult.split(",")]

    def seg_phases(t):
        ph = [{"name": f"{t}:pre", "duration": 10, "rates": {}}]
        for m in mult:
            r = round(min(rates[t], CAPS.get(t, 1e9)) * m, 3)
            s = f"{t}@{r:g}"
            ph += [{"name": f"{s}:warm", "duration": 5, "rates": {t: r}},
                   {"name": f"{s}:steady", "duration": a.steady, "rates": {t: r}},
                   {"name": f"{s}:drain", "duration": 5, "rates": {}}]
        return ph
    blocks = pack_blocks(types)
    lens = [sum(p["duration"] for t in b for p in seg_phases(t)) for b in blocks]
    out = []
    for k, w in enumerate(balance(blocks, lens, 30 + 20)):
        ph = [{"name": "idle", "duration": 30, "rates": {}}] + [p for t in w for p in seg_phases(t)] + \
             [{"name": "idle_end", "duration": 20, "rates": {}}]
        out.append({"name": f"pilot_w{k + 1}", "config": "off", "block": 1, "rateLevel": "pilot", "types": w,
                    "prep": prep_for(w), "durationS": sum(p["duration"] for p in ph), "phases": ph})
    d = a.out or os.path.join(HERE, "pilot")
    write(d, out, {"variant": "pilot", "multipliers": mult,
                   "note": "run with run.py measure --pilot (no lock, marked invalid); then analyze_iso.py over the "
                           "windows and gen_plans.py pilot-rates"})
    json.dump(warm_plan(rates), open(os.path.join(d, "warm_timing.json"), "w"), indent=1)


def cmd_pilot_rates(a):
    """analyze_iso.py output of the pilot windows -> per type the rate at which the busiest CPU-limited container
    is at 25 % (mid) / 5 % (low) of its limit (linear in the rate, slope = median over the pilot's rates)."""
    iso = json.load(open(a.iso))
    limits = {}
    for d in a.windows.split(","):
        w = json.load(open(os.path.join(d.strip(), "window.json")))
        for k, v in (w.get("limits") or {}).items():
            cm = (v or {}).get("cpu.max")
            if cm and not cm.startswith("max"):
                q, p = cm.split()
                limits[k] = int(q) / int(p)
    slopes = {}
    for win in iso["windows"]:
        for seg, r in win["types"].items():
            t = seg.split("@")[0]
            best = None
            for k, c in r["containers"].items():
                if k in limits and c.get("D") is not None:
                    u = c["D"] / 1000 / limits[k]       # fraction of the limit per (request/s)
                    if best is None or u > best[0]:
                        best = (u, k)
            if best and r.get("X"):
                slopes.setdefault(t, []).append(best)
    out = {}
    for t, v in slopes.items():
        v.sort()
        u, k = v[len(v) // 2]
        if u <= 0:
            continue
        out[t] = {"mid": round(min(a.mid / u, CAPS.get(t, 1e9)), 3), "low": round(min(a.low / u, CAPS.get(t, 1e9)), 3),
                  "busiest": k, "utilPerRps": round(u, 5)}
    res = {"source": {"iso": a.iso, "windows": a.windows}, "target": {"mid": a.mid, "low": a.low}, "rates": out,
           "missing": [t for t in types_all() if t not in out]}
    json.dump(res, open(a.out, "w"), indent=1)
    print(f"{a.out}: {len(out)} types, missing {res['missing']}")


FO_BURST_CELLS = ["i1q1c1INVs60", "i1q1c1PREs60", "i1q1c1CCs60"]     # burst_table.py: one cell per payment method
MECH_BURST_SCALE = 0.5     # block 6: every switch change restarts order/catalog/shipment, so its bursts repeat 4 times
MECH_ON3 = {"localCopies": True, "entityCache": True, "cacheTtlS": 60, "sharedCache": True}


def cmd_approx3(a):
    """The campaign's plans (README.md §4.1): off and on windows of every type with warm-up bursts, 3 factorial
    windows, the latency window at sampler 0.1 (same JVMs as block 3), block 6 with the shared-key cache and the
    caller-side cache windows, the at-load window."""
    check_against_domain()
    types = reads_first(types_all())
    mid, low = rates_for(a.rates, "mid"), rates_for(a.rates, "low")
    plans = [window_plan(f"off_w{k + 1}", w, mid, STEADY, "off", 2, "mid") for k, w in enumerate(pack(types, STEADY))]
    plans += [window_plan(f"on_w{k + 1}", w, mid, STEADY, "on", 3, "mid") for k, w in enumerate(pack(types, STEADY))]
    for p in plans:
        p["burstTypes"] = list(p["types"])
    fo = fo_windows("fo", "on", fo_cells())
    for p in fo:
        p["burstTypes"] = [f"foOrder.{c}" for c in FO_BURST_CELLS]
        p["prep"] = [PREP_MAINTAIN, PREP_STOCK]
    plans += fo
    lat = latency_plan(types)
    lat.update(burstTypes=list(types), sampler="0.1")
    plans.append(lat)
    mech = mech_windows(mid, low)
    for p in mech:
        if p["mechanisms"]["localCopies"]:
            p["mechanisms"] = dict(MECH_ON3)
        else:                               # the reference of the caller cache's hot key set
            with_hot_order(p, mid["createOrder"])
        p["burstTypes"] = list(p["types"])
        p["burstScale"] = MECH_BURST_SCALE
    cc = caller_cache_windows(mid)
    # run order inside the stack modes: off config: mech_off_w1, mech_cc_w1, mech_on_w1; on config: mech_on_w2, mech_cc_w2
    plans += [mech[0], cc[0], mech[1], mech[2], cc[1]]
    at = atload_plan()
    at["burstTypes"] = [t for t in types_all() if t not in ("products.anon", "product.anon")]
    plans.append(at)
    out = a.out or os.path.join(HERE, "approx3")
    write(out, plans, {"variant": "approx3", "rates": a.rates or "defaults (no pilot yet)", "creating": sorted(CREATING),
                       "readsFirst": True, "bursts": "bursts.json (burst_table.py)",
                       "foCells": fo_cells(), "foBurstCells": FO_BURST_CELLS})
    json.dump(warm_plan(mid), open(os.path.join(out, "warm_timing.json"), "w"), indent=1)
    json.dump(mech_warm_plan(mid), open(os.path.join(out, "warm_mech.json"), "w"), indent=1)


CALLER_TARGETS = "shipment,discount,inventory"   # README.md §4.1: not shoppingcart (the cart changes)
MECH_CC = {"localCopies": False, "entityCache": False, "cacheTtlS": 60, "callerCache": CALLER_TARGETS}


def with_hot_order(p, rate):
    """Append a createOrder.hot segment (the caller cache's hot key set) before idle_end."""
    end = p["phases"].pop()
    p["phases"] += segment("createOrder.hot", rate) + [end]
    p["types"].append("createOrder.hot")
    p["baseTypes"]["createOrder.hot"] = "createOrder"
    p["durationS"] = sum(x["duration"] for x in p["phases"])
    return p


def caller_cache_windows(mid):
    """Block 6, caller-side cache of order's sync invocations (README.md §4.1; misarch-kotlin docs/MECHANISMS.md):
    local copies and the entity cache off, MISARCH_CALLER_CACHE_TARGETS = shipment,discount,inventory, TTL 60 s.
    cold = loadgen's createOrder after a cart fill (fresh cart lines: every lookup a miss), hot = createOrder.hot
    (4 fixed buyer/cart/method triples: hits after the first per TTL). The reference (switch off, same two segments)
    is mech_off_w1. Totals in the production configuration, shares and the `cache <target>` spans instrumented."""
    out = []
    for name, cfg in (("mech_cc_w1", "off"), ("mech_cc_w2", "on")):
        r = mid["createOrder"]
        carts = math.ceil(r * (WARM + STEADY) * 1.1 + 10)
        ph = [{"name": "idle", "duration": IDLE, "rates": {}},
              {"name": "createShoppingcartItem:fill", "duration": MECH_FILL,
               "rates": {"createShoppingcartItem": round(carts / MECH_FILL, 3)}}]
        ph += segment("createOrder", r) + segment("createOrder.hot", r)
        ph.append({"name": "idle_end", "duration": IDLE_END, "rates": {}})
        types = ["createOrder", "createOrder.hot"]
        out.append({"name": name, "config": cfg, "block": 6, "rateLevel": "mid", "types": types,
                    "baseTypes": {"createOrder": "createOrder", "createOrder.hot": "createOrder"},
                    "mechanisms": dict(MECH_CC), "prep": [PREP_MAINTAIN], "warm": "warm_mech.json",
                    "burstTypes": types, "burstScale": MECH_BURST_SCALE, "durationS": sum(p["duration"] for p in ph), "phases": ph})
    return out


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("pilot")
    p.add_argument("--out")
    p.add_argument("--mult", default="0.4,1,2.5")
    p.add_argument("--steady", type=float, default=20)
    p = sp.add_parser("pilot-rates")
    p.add_argument("--iso", required=True)
    p.add_argument("--windows", required=True)
    p.add_argument("--out", default=os.path.join(HERE, "rates.json"))
    p.add_argument("--mid", type=float, default=0.25)
    p.add_argument("--low", type=float, default=0.05)
    p = sp.add_parser("approx3")
    p.add_argument("--rates")
    p.add_argument("--out")
    a = ap.parse_args()
    if a.cmd == "pilot":
        cmd_pilot(a)
    elif a.cmd == "pilot-rates":
        cmd_pilot_rates(a)
    else:
        cmd_approx3(a)


if __name__ == "__main__":
    main()

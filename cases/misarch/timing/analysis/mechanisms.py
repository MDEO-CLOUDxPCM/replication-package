#!/usr/bin/env python3
"""Block 6 (mechanisms build): local copies in order and the entity-fetch response cache (README.md §4.1,
block 6). Writes the `mechanisms` section that parts.py embeds in timing/parts.json.

    mechanisms.py [--off approx4_mech_off_w1] [--on approx4_mech_on_w1] [--instr approx4_mech_on_w2[,RERUN]]
                  [--ref approx4_off_w2,approx4_off_w3] [--parts timing/parts.json] [--out timing/raw/mechanisms.json]
                  [--cc-on approx4_mech_cc_w1 --cc-instr approx4_mech_cc_w2 [--cc-off W]]

Windows: `off` = copies and cache off (reference, production config), `on` = both on (production config), `instr` =
both on, instrumented (shares: pg_stat_statements, profiles, spans). Totals D (ms CPU per request per container) are
calibration's analyze_iso totals, as everywhere (parts.iso_totals). Segment types carry `baseTypes` in the plan
(orderTracking.hot -> orderTracking).

1. Local copies, createOrder: D per container off vs on. The remote calls the copies replace (discount's
   findApplicableDiscounts, shipment's calculateShipmentFees) cost the callee app + DB + its two sidecars, plus the
   caller's sidecar (order-dapr off - on, per removed call); the copy read costs order's app delta and order-db's
   delta; its statements (local_copy_* in the instr window) give DB exec ms per statement, x k_db = DB CPU.
2. Entity cache, orderTracking (shipment, Order) and wishlistView (catalog, ProductVariant): hot key sets (all hit
   after the first request per key) vs cold ones (all miss) vs the same key sets with the cache off. Provider cost
   per lookup at hit ratio h (cache_counts.json): hit = (D_hot - (1 - h) D_cold) / h, miss = D_cold, uncached =
   the mean of D_off over both key sets (they do the same provider work; their difference, up to 1 ms, is noise).
   Saving per hit = uncached - hit, miss overhead = miss - uncached. Lookups per
   request from the counters.
4. Caller-side cache (README.md §4.1): order caches createOrder's sync invocations of shipment, discount and
   inventory (key = target + method + request body). Windows: `cc-off` = the reference with the switch off (the off
   window's createOrder and createOrder.hot segments), `cc-on` = the switch on (production config), `cc-instr` = on,
   instrumented (`cache <target>` spans, profile). Per target from order's caller-cache counters (cache_counts.json
   `byTarget`): lookups per createOrder and the hit ratio of the hot set (createOrder.hot: 4 fixed buyer/cart/method
   triples) and of the cold one (loadgen's createOrder after a fill: mostly misses, repeated bodies hit). Saving per hit, per provider
   container (app, DB, sidecars) = (D_off_hot - D_on_hot) / (lookups x h); the caller side (order app, order's
   sidecars) is not separable by target: per hit over all targets' hits = (D_on_hot - D_off_hot) / hits per request
   (the app's value is the hit cost net of the saved outbound call's client work; negative = a saving) and the miss
   overhead from D_on - D_off = hits x perHit + misses x missOverhead in the hot and in the cold segment.
3. Copy writes: per copy-feeding request type (run at the low rate in `on`), order's cost: app, DB, sidecars. The
   reference is order's cost of the same type in block 2 (`ref`, cut images, mid rate; 0 for the topics order
   subscribes only with copies on). Per event: the local_copy_* writes per request in the instr window, which are
   one per delivered copy event. DB per copy write = exec ms x k_db(order-db).
"""
import argparse
import collections
import gzip
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import parts  # noqa: E402
import speed  # noqa: E402

# copy tables of the mechanisms build before the unification (V2/V3__local_copies.sql) -> (copy of, topics that feed it)
COPY_TABLES = {
    "local_copy_discounts": ("Discount", ["discount/discount/created", "discount/discount/updated"]),
    "local_copy_coupon_discounts": ("Coupon", ["discount/coupon/created"]),
    "local_copy_products": ("Product", ["catalog/product/created", "catalog/product/updated"]),
    "local_copy_variant_products": ("ProductVariant", ["catalog/product-variant/created"]),
    "local_copy_shipment_methods": ("ShipmentMethod", ["shipment/shipment-method/created",
                                                      "shipment/shipment-method/archived"]),
    "local_copy_version_weights": ("ProductVariantVersion", ["catalog/product-variant-version/created"]),
}
# the same copies in the unified build (order V2__local_copies.sql: LocalCopy<Entity>, unquoted, so lower case in the
# statements); the windows up to approx3 have the names above
COPY_TABLES.update({
    "localcopydiscountentity": COPY_TABLES["local_copy_discounts"],
    "localcopycouponentity": COPY_TABLES["local_copy_coupon_discounts"],
    "localcopyproductentity": COPY_TABLES["local_copy_products"],
    "localcopyproductvariantentity": COPY_TABLES["local_copy_variant_products"],
    "localcopyshipmentmethodentity": COPY_TABLES["local_copy_shipment_methods"],
    "localcopyproductvariantversionentity": COPY_TABLES["local_copy_version_weights"],
})


def is_copy_table(table):
    """A table of order's local copies (either build's names)."""
    t = (table or "").lower()
    return t.startswith("local_copy_") or t.startswith("localcopy")
# topics order subscribes to without the switch (main): the copy write is an extra upsert in an existing handler
SUBSCRIBED_BEFORE = {"discount/coupon/created", "shipment/shipment-method/created",
                     "catalog/product-variant-version/created"}      # domain: order.on:<topic> on main
# copy-write request type -> the copy topics it publishes to order, per request (README.md §4.1)
COPY_EVENTS = {
    "discount.createDiscount": ["discount/discount/created"],
    "discount.updateDiscount": ["discount/discount/updated"],
    "discount.createCoupon": ["discount/coupon/created"],
    "adminCreateProduct": ["catalog/product/created", "catalog/product-variant/created",
                           "catalog/product-variant-version/created"],
    "adminUpdateProduct": ["catalog/product/updated"],
    "adminCreateVariant": ["catalog/product-variant/created", "catalog/product-variant-version/created"],
    "adminNewPrice": ["catalog/product-variant-version/created"],
    "shipment.createShipmentMethod": ["shipment/shipment-method/created"],
    "shipment.archiveShipmentMethod": ["shipment/shipment-method/archived"],
}
CACHES = {"orderTracking": ("shipment", "Order"), "wishlistView": ("catalog", "ProductVariant")}
REMOVED_CALLS = {"discount": "discount.findApplicableDiscounts", "shipment": "shipment.calculateShipmentFees"}
SIDECARS = ("-dapr", "-ecs")


def r3(x):
    return None if x is None else round(x, 3)


def stack_cost(D, svc):
    """{app, db, dapr, ecs, total} of a service's containers in one request type's totals."""
    out = {"app": D.get(svc, 0.0), "db": D.get(f"{svc}-db", 0.0), "dapr": D.get(f"{svc}-dapr", 0.0),
           "ecs": D.get(f"{svc}-ecs", 0.0)}
    out["total"] = sum(out.values())
    return {k: r3(v) for k, v in out.items()}


def per_lookup(d_hot, d_cold, hit_ratio):
    """Provider cost per lookup: (hit, miss) from the hot segment (hit ratio h) and the cold one (all miss):
    D_hot = h hit + (1 - h) miss, miss = D_cold."""
    if hit_ratio is None or hit_ratio <= 0:
        return None, d_cold
    return (d_hot - (1 - hit_ratio) * d_cold) / hit_ratio, d_cold


def per_event(delta, events):
    return None if not events else delta / events


def cache_spans(d):
    """{entity: {hit|miss: [durations ms]}} of the `cache <Type>` spans (misarch.cache tag)."""
    p = os.path.join(d, "spans.json.gz")
    out = collections.defaultdict(lambda: collections.defaultdict(list))
    if not os.path.exists(p):
        return out
    for s in json.load(gzip.open(p, "rt")):
        tg = s.get("tags") or {}
        if tg.get("misarch.cache") and (s.get("name") or "").startswith("cache"):
            out[tg.get("misarch.entity")][tg["misarch.cache"]].append(s.get("duration", 0) / 1000)
    return out


def quantiles(v):
    if not v:
        return None
    v = sorted(v)
    return {"n": len(v), "p50": r3(st.median(v)), "p90": r3(v[int(0.9 * (len(v) - 1))]), "mean": r3(st.mean(v))}


def instr_data(instr_ws):
    """The instrumented windows merged per segment (a re-run window listed last replaces its segments, as parts.py):
    -> (totals, queries segments, bucket segments, cache counts, cache spans)."""
    T, seg_q, seg_b, counts, spans = {}, {}, {}, {}, {}
    for w in instr_ws:
        d = common.window_dir(w)
        T.update(parts.iso_totals(d)[0])
        q = common.load_json(d, "analysis/queries.json")
        if q is None:
            import queries
            q = queries.analyse_window(d)
        seg_q.update(q["segments"])
        seg_b.update((common.load_json(d, "analysis/buckets.json") or {}).get("segments", {}))
        counts.update(common.load_json(d, "cache_counts.json", {}))
        spans.update(cache_spans(d))
    return T, seg_q, seg_b, counts, spans


def analyse(off_w, on_w, instr_w, ref_ws, parts_json=None, cc_windows=None):
    instr_ws = instr_w.split(",")
    d_off, d_on = (common.window_dir(w) for w in (off_w, on_w))
    T_off, _ = parts.iso_totals(d_off)
    T_on, _ = parts.iso_totals(d_on)
    T_in, seg_q, seg_b, counts_in, spans_in = instr_data(instr_ws)
    ref = {}
    for w in ref_ws:
        ref.update(parts.iso_totals(common.window_dir(w))[0])
    b = {"segments": seg_b}
    counts_on = common.load_json(d_on, "cache_counts.json", {})
    P = parts_json or {}
    k_db_order = (P.get("kDb", {}).get("order-db") or {}).get("median")
    out = {"source": "timing/analysis/mechanisms.py", "windows": {"off": os.path.basename(d_off),
                                                                  "on": os.path.basename(d_on),
                                                                  "instrumented": instr_ws if len(instr_ws) > 1 else instr_w,
                                                                  "reference": ref_ws},
           "units": "ms per request (CPU ms at full speed of one core for app/sidecar containers, DB container CPU ms "
                    "for -db), production configuration unless named instrumented",
           "speedRegime": {w: speed.window_regime(w)["regime"] for w in [off_w, on_w] + instr_ws}}

    # 1. local copies, createOrder ---------------------------------------------------------------------------
    co_off, co_on, co_in = T_off["createOrder"]["D"], T_on["createOrder"]["D"], T_in["createOrder"]["D"]
    conts = sorted({c for c in set(co_off) | set(co_on) if not c.startswith("engine:")
                    and max(abs(co_off.get(c, 0)), abs(co_on.get(c, 0))) >= 0.2})
    removed = {}
    for svc, op in REMOVED_CALLS.items():
        removed[svc] = {"operation": op, "calleeOff": stack_cost(co_off, svc), "calleeOn": stack_cost(co_on, svc)}
    n_calls = len(REMOVED_CALLS)
    caller_hop = (co_off.get("order-dapr", 0) - co_on.get("order-dapr", 0)) / n_calls
    copy_stmts = [s for s in seg_q.get("createOrder:steady", {}).get("statements", [])
                  if s["service"] == "order" and is_copy_table(s.get("table"))]
    k_db_seg = seg_q.get("createOrder:steady", {}).get("dbs", {}).get("order-db", {}).get("kDb") or k_db_order
    read_exec = sum(s["execMsPerReq"] for s in copy_stmts)
    read_calls = sum(s["callsPerReq"] for s in copy_stmts)
    app_delta = co_on.get("order", 0) - co_off.get("order", 0)
    db_delta = co_on.get("order-db", 0) - co_off.get("order-db", 0)
    saved = sum(removed[s]["calleeOff"]["total"] - removed[s]["calleeOn"]["total"] for s in removed) + caller_hop * n_calls
    out["localCopies"] = {
        "createOrder": {
            "X": {"off": r3(T_off["createOrder"]["X"]), "on": r3(T_on["createOrder"]["X"])},
            "errRate": {"off": T_off["createOrder"]["errRate"], "on": T_on["createOrder"]["errRate"]},
            "D": {c: {"off": r3(co_off.get(c)), "on": r3(co_on.get(c)), "delta": r3(co_on.get(c, 0) - co_off.get(c, 0)),
                      "onInstrumented": r3(co_in.get(c))} for c in conts},
            "removedCalls": removed,
            "callerSidecarPerCallMs": r3(caller_hop),
            "copyRead": {
                "statements": [{"table": s["table"], "copyOf": COPY_TABLES.get(s["table"].lower(), (None,))[0],
                                "callsPerReq": s["callsPerReq"], "rowsPerReq": s["rowsPerReq"],
                                "execMsPerReq": s["execMsPerReq"],
                                "dbMs": r3(s["execMsPerReq"] * k_db_seg) if k_db_seg else None} for s in copy_stmts],
                "statementsPerRequest": r3(read_calls),
                "dbExecMsPerRequest": r3(read_exec),
                "kDb": k_db_seg,
                "dbMsPerRequest": r3(read_exec * k_db_seg) if k_db_seg else None,
                "dbMsPerStatement": r3(read_exec * k_db_seg / read_calls) if k_db_seg and read_calls else None,
                "dbDeltaCgroupMs": r3(db_delta),
                "appDeltaMs": r3(app_delta),
                "note": "appDeltaMs = order's app CPU with copies minus without: the copy reads' mapping, the in-memory "
                        "discount match and fee computation, minus the two saved outgoing invocations' client work",
            },
            "netSavingMs": r3(saved - app_delta - db_delta),
            "savedMs": r3(saved),
        }}

    # 2. entity cache -----------------------------------------------------------------------------------------
    spans = spans_in
    caches = {}
    for base, (prov, entity) in CACHES.items():
        hot, cold = f"{base}.hot", f"{base}.cold"
        e = {"provider": prov, "entity": entity, "segments": {}}
        for t in (hot, cold):
            e["segments"][t] = {
                "X": {"off": r3(T_off[t]["X"]), "on": r3(T_on[t]["X"]), "instr": r3(T_in[t]["X"])},
                "counters": {"on": counts_on.get(f"{t}:steady", {}).get(prov),
                             "instr": counts_in.get(f"{t}:steady", {}).get(prov)},
                "D": {c: {"off": r3(T_off[t]["D"].get(c)), "on": r3(T_on[t]["D"].get(c)),
                          "instr": r3(T_in[t]["D"].get(c))}
                      for c in sorted(set(T_off[t]["D"]) | set(T_on[t]["D"]))
                      if not c.startswith("engine:") and max(abs(T_off[t]["D"].get(c, 0)), abs(T_on[t]["D"].get(c, 0))) >= 0.2}}
        res = {}
        for cfg, T, counts in (("production", T_on, counts_on), ("instrumented", T_in, counts_in)):
            c_hot = counts.get(f"{hot}:steady", {}).get(prov) or {}
            c_cold = counts.get(f"{cold}:steady", {}).get(prov) or {}
            h = c_hot.get("hitRatio")
            n_hot = T[hot]["X"] * c_hot.get("seconds", 75) if T[hot]["X"] else None
            lookups = (c_hot.get("hits", 0) + c_hot.get("misses", 0)) / n_hot if n_hot else None
            r = {"hitRatioHot": h, "hitRatioCold": c_cold.get("hitRatio"), "lookupsPerRequest": r3(lookups)}
            for part, key in (("app", prov), ("db", f"{prov}-db")):
                Doff_h = T_off[hot]["D"].get(key, 0.0)
                Doff_c = T_off[cold]["D"].get(key, 0.0)
                unc = (Doff_h + Doff_c) / 2     # the two key sets do the same provider work; their difference is noise
                hit, miss = per_lookup(T[hot]["D"].get(key, 0.0), T[cold]["D"].get(key, 0.0), h)
                r[part] = {"uncachedHot": r3(Doff_h), "uncachedCold": r3(Doff_c), "uncached": r3(unc),
                           "uncachedBlock2": r3(ref.get(base, {}).get("D", {}).get(key)),
                           "hit": r3(hit), "miss": r3(miss),
                           "savingPerHit": r3(unc - hit) if hit is not None else None,
                           "missOverhead": r3(miss - unc)}
            res[cfg] = r
        e["perLookup"] = res
        # where the miss overhead goes: profile buckets of the provider, hot vs cold (instrumented window)
        if b:
            e["providerBucketsMsPerRequest"] = {}
            for t in (hot, cold):
                v = (b["segments"].get(f"{t}:steady") or {}).get(prov)
                n = T_in[t]["X"] * 75 if T_in[t]["X"] else None
                if v and n:
                    e["providerBucketsMsPerRequest"][t] = {k: r3(x / n) for k, x in v["netMs"].items() if x / n >= 0.02}
        e["spans"] = {k: quantiles(v) for k, v in spans.get(entity, {}).items()}
        caches[base] = e
    out["entityCache"] = caches

    # 3. copy writes ------------------------------------------------------------------------------------------
    cw = {}
    for t, topics in COPY_EVENTS.items():
        if t not in T_on:
            continue
        s = seg_q.get(f"{t}:steady", {})
        writes = [x for x in s.get("statements", []) if x["service"] == "order" and x["kind"] == "write"]
        copy_w = [x for x in writes if is_copy_table(x.get("table"))]
        n_events = sum(x["callsPerReq"] for x in copy_w)
        exec_copy = sum(x["execMsPerReq"] for x in copy_w)
        Don = T_on[t]["D"]
        Dref = ref.get(t, {}).get("D", {})
        new_topics = [x for x in topics if x not in SUBSCRIBED_BEFORE]
        row = {"topics": topics, "newSubscriptions": new_topics, "rate": r3(T_on[t]["X"]),
               "refRate": r3(ref[t]["X"]) if t in ref else None,
               "copyWritesPerRequest": r3(n_events),
               "copyWriteExecMsPerRequest": r3(exec_copy),
               "copyWriteDbMsPerEvent": r3(exec_copy * k_db_order / n_events) if k_db_order and n_events else None,
               "order": {}}
        for c in ("order", "order-db", "order-dapr", "order-ecs"):
            on_v = Don.get(c, 0.0)
            ref_v = Dref.get(c, 0.0) if t in ref else 0.0
            row["order"][c] = {"on": r3(on_v), "se": r3(T_on[t]["se"].get(c)), "reference": r3(ref_v),
                               "delta": r3(on_v - ref_v),
                               "deltaPerEvent": r3(per_event(on_v - ref_v, len(topics)))}
        cw[t] = row
    # parameters: per delivered copy event, over the request types whose events are all new subscriptions (the
    # whole handler is copy maintenance) and over those that add an upsert to an existing handler
    def med(vals):
        vals = [v for v in vals if v is not None]
        return r3(st.median(vals)) if vals else None
    only_new = [t for t, r in cw.items() if len(r["newSubscriptions"]) == len(r["topics"])]
    only_old = [t for t, r in cw.items() if not r["newSubscriptions"]]
    out["copyWrites"] = {
        "byRequest": cw,
        "perEvent": {
            "newSubscription": {"types": only_new,
                                "appCpuMs": med(cw[t]["order"]["order"]["deltaPerEvent"] for t in only_new),
                                "sidecarDaprCpuMs": med(cw[t]["order"]["order-dapr"]["deltaPerEvent"] for t in only_new),
                                "sidecarEcsCpuMs": med(cw[t]["order"]["order-ecs"]["deltaPerEvent"] for t in only_new),
                                "dbCgroupMs": med(cw[t]["order"]["order-db"]["deltaPerEvent"] for t in only_new)},
            "extraUpsertInExistingHandler": {"types": only_old,
                                             "appCpuMs": med(cw[t]["order"]["order"]["deltaPerEvent"] for t in only_old),
                                             "dbCgroupMs": med(cw[t]["order"]["order-db"]["deltaPerEvent"] for t in only_old)},
            "dbMsPerCopyWrite": med(r["copyWriteDbMsPerEvent"] for r in cw.values()),
            "dbExecMsPerCopyWrite": med((r["copyWriteExecMsPerRequest"] / r["copyWritesPerRequest"])
                                        if r["copyWritesPerRequest"] else None for r in cw.values()),
            "kDb": k_db_order,
            "note": "app CPU per event at the copy writes' low rate (1-2 requests/s): an upper bound (sensitivity, "
                    "RESULTS §sensitivity); DB per copy write from pg_stat_statements exec x k_db (the cgroup delta "
                    "of order-db at these rates is noise of +-0.5 ms)"}}
    if cc_windows and cc_windows[1]:
        out["callerCache"] = caller_cache(cc_windows[0] or off_w, cc_windows[1], cc_windows[2])
    out["parameters"] = parameters(out)
    return out


CALLER_TARGETS = ("shipment", "discount", "inventory")


def caller_cache(off_w, on_w, instr_w=None):
    """Section 4: the caller-side cache of order (see the docstring)."""
    d_off, d_on = common.window_dir(off_w), common.window_dir(on_w)
    T_off, _ = parts.iso_totals(d_off)
    T_on, _ = parts.iso_totals(d_on)
    counts = common.load_json(d_on, "cache_counts.json", {})
    hot, cold = "createOrder.hot", "createOrder"
    if hot not in T_off or hot not in T_on:
        return None
    out = {"windows": {"off": os.path.basename(d_off), "on": os.path.basename(d_on),
                       "instrumented": os.path.basename(common.window_dir(instr_w)) if instr_w else None},
           "speedRegime": {w: speed.window_regime(w)["regime"] for w in (off_w, on_w) + ((instr_w,) if instr_w else ())},
           "X": {t: {"off": r3(T_off[t]["X"]), "on": r3(T_on[t]["X"])} for t in (hot, cold)}, "targets": {}}
    per = {}
    for t in (hot, cold):
        c = (counts.get(f"{t}:steady") or {}).get("order") or {}
        n = T_on[t]["X"] * c.get("seconds", 75) if T_on[t]["X"] else None
        per[t] = {tg: {"hits": x["hits"] / n, "misses": x["misses"] / n, "hitRatio": x.get("hitRatio")}
                  for tg, x in (c.get("byTarget") or {}).items()} if n else {}
    hits_hot = sum(v["hits"] for v in per[hot].values())
    miss_cold = sum(v["misses"] for v in per[cold].values())
    for tg in CALLER_TARGETS:
        ph, pc = per[hot].get(tg, {}), per[cold].get(tg, {})
        lk = (ph.get("hits", 0) + ph.get("misses", 0)) or None
        h = ph.get("hitRatio")
        e = {"lookupsPerRequest": r3(lk), "hitRatioHot": h, "hitRatioCold": pc.get("hitRatio"),
             "hitsPerRequestHot": r3(ph.get("hits")), "provider": {}}
        tot = 0.0
        for suf in ("", "-db", "-dapr", "-ecs"):
            c = f"{tg}{suf}"
            v = {k: T[t]["D"].get(c, 0.0) for k, T, t in (("offHot", T_off, hot), ("onHot", T_on, hot),
                                                            ("offCold", T_off, cold), ("onCold", T_on, cold))}
            sav = (v["offHot"] - v["onHot"]) / (lk * h) if lk and h else None
            tot += sav or 0.0
            e["provider"][suf.lstrip("-") or "app"] = dict({k: r3(x) for k, x in v.items()}, savingPerHit=r3(sav),
                                                          coldDelta=r3(v["onCold"] - v["offCold"]))
        e["providerSavingPerHitMs"] = r3(tot)
        out["targets"][tg] = e
    # the cold set is not all misses (repeated inventory / shipment bodies under Zipf products): per caller container
    # D_on - D_off = hits x perHit + misses x missOverhead in both segments, solved for the two unknowns
    miss_hot = sum(v["misses"] for v in per[hot].values())
    hits_cold = sum(v["hits"] for v in per[cold].values())
    det = hits_hot * miss_cold - miss_hot * hits_cold
    caller = {}
    for c in ("order", "order-db", "order-dapr", "order-ecs"):
        v = {k: T[t]["D"].get(c, 0.0) for k, T, t in (("offHot", T_off, hot), ("onHot", T_on, hot),
                                                        ("offCold", T_off, cold), ("onCold", T_on, cold))}
        dh, dc = v["onHot"] - v["offHot"], v["onCold"] - v["offCold"]
        if abs(det) > 1e-9:
            ph_, mo = (dh * miss_cold - miss_hot * dc) / det, (hits_hot * dc - hits_cold * dh) / det
        else:
            ph_ = dh / hits_hot if hits_hot else None
            mo = dc / miss_cold if miss_cold else None
        caller[c] = dict({k: r3(x) for k, x in v.items()}, perHit=r3(ph_), missOverhead=r3(mo))
    out["caller"] = caller
    out["hitsPerRequestHot"], out["missesPerRequestCold"] = r3(hits_hot), r3(miss_cold)
    out["missesPerRequestHot"], out["hitsPerRequestCold"] = r3(miss_hot), r3(hits_cold)
    if instr_w:
        di = common.window_dir(instr_w)
        sp = collections.defaultdict(lambda: collections.defaultdict(list))
        p = os.path.join(di, "spans.json.gz")
        if os.path.exists(p):
            for x in json.load(gzip.open(p, "rt")):
                tg = x.get("tags") or {}
                if tg.get("misarch.cache") and (x.get("name") or "").startswith("cache") and tg.get("misarch.app"):
                    sp[tg["misarch.app"]][tg["misarch.cache"]].append(x.get("duration", 0) / 1000)
        out["spans"] = {a: {k: quantiles(v) for k, v in x.items()} for a, x in sp.items()}
        ci = common.load_json(di, "cache_counts.json", {})
        out["countersInstrumented"] = {t: (ci.get(f"{t}:steady") or {}).get("order") for t in (hot, cold)}
    return out


def parameters(m):
    """The mechanism parameters the model needs (gen_domain.py's msa System keys), from the sections above."""
    lc = m["localCopies"]["createOrder"]
    ce = m["entityCache"]
    pe = m["copyWrites"]["perEvent"]
    hit_app = {b: ce[b]["perLookup"]["production"]["app"] for b in ce}
    hit_db = {b: ce[b]["perLookup"]["production"]["db"] for b in ce}

    def mean(vals):
        vals = [v for v in vals if v is not None]
        return r3(sum(vals) / len(vals)) if vals else None
    removed = lc["removedCalls"]
    return {
        "replicaReadDbMs": {"value": lc["copyRead"]["dbMsPerStatement"], "unit": "DB ms per copy read statement",
                            "perCreateOrder": lc["copyRead"]["dbMsPerRequest"], "round2": 0.3, "approximate": False},
        "replicaReadCpuMs": {"value": lc["copyRead"]["appDeltaMs"], "unit": "app CPU ms per createOrder answered from copies "
                             "(net: copy reads, in-memory match and fees, minus the saved invocations' client work)",
                             "inModel": False, "approximate": True},
        "replicaWriteCpuMs": {"value": pe["newSubscription"]["appCpuMs"], "unit": "app CPU ms per delivered copy event "
                              "(whole handler, inbound HTTP included)", "extraUpsertOnly": pe["extraUpsertInExistingHandler"]["appCpuMs"],
                              "round2": 1.669, "approximate": True},
        "replicaWriteDbMs": {"value": pe["dbMsPerCopyWrite"], "unit": "DB ms per copy write (upsert)", "round2": 0.943,
                             "approximate": False},
        "deliverCpuMs": {"value": r3((pe["newSubscription"]["sidecarDaprCpuMs"] or 0) + (pe["newSubscription"]["sidecarEcsCpuMs"] or 0)),
                         "unit": "sidecar CPU ms per delivered event on the subscriber (dapr + ecs)", "round2": 1.1,
                         "approximate": True},
        "cacheHitCpuMs": {"value": mean(v["hit"] for v in hit_app.values()), "byCache": {b: v["hit"] for b, v in hit_app.items()},
                          "unit": "provider app CPU ms per hit (the hit is served behind the provider's sidecar: hop and "
                                  "gateway fetch remain)", "round2": 0.1, "approximate": False},
        "cacheMissOverheadCpuMs": {"value": mean(v["missOverhead"] for v in hit_app.values()),
                                   "byCache": {b: v["missOverhead"] for b, v in hit_app.items()},
                                   "unit": "provider app CPU ms per miss on top of the uncached call (store + GC)",
                                   "inModel": False, "approximate": True},
        "cacheHitSavingMs": {"byCache": {b: {"app": hit_app[b]["savingPerHit"], "db": hit_db[b]["savingPerHit"]} for b in ce},
                             "unit": "provider app / DB ms saved per hit vs the uncached call"},
        "cacheHitRatio": {"value": None, "measuredHot": {b: ce[b]["perLookup"]["production"]["hitRatioHot"] for b in ce},
                          "note": "a workload property (key reuse within the TTL), not measured: the hot sets are 4 keys "
                                  "by construction; keep the model's assumption"},
        "remoteCallReplaced": {s: {"calleeTotalMs": v["calleeOff"]["total"], "callee": v["calleeOff"],
                                   "callerSidecarMs": lc["callerSidecarPerCallMs"]} for s, v in removed.items()},
        **caller_parameters(m.get("callerCache")),
    }


def caller_parameters(cc):
    if not cc:
        return {}
    return {
        "callerCacheHitCpuMs": {"value": cc["caller"]["order"]["perHit"],
                                "unit": "caller (order) app CPU ms per hit, net of the saved outbound call's client "
                                        "work (negative = the hit saves CPU in the caller too)", "approximate": True},
        "callerCacheSidecarSavingMs": {"value": r3(-sum((cc["caller"][c]["perHit"] or 0) for c in ("order-dapr", "order-ecs"))),
                                       "unit": "caller sidecars' CPU ms saved per hit (dapr + ecs)"},
        "callerCacheMissOverheadCpuMs": {"value": cc["caller"]["order"]["missOverhead"],
                                         "unit": "caller app CPU ms per miss on top of the uncached call", "inModel": False},
        "callerCacheProviderSavingMs": {"byTarget": {t: {"total": v["providerSavingPerHitMs"],
                                                         **{k: x["savingPerHit"] for k, x in v["provider"].items()}}
                                                     for t, v in cc["targets"].items()},
                                        "unit": "provider app / DB / sidecar CPU ms saved per hit"},
        "callerCacheHitRatio": {"value": None, "measuredHot": {t: v["hitRatioHot"] for t, v in cc["targets"].items()},
                                "note": "a workload property (identical request bodies within the TTL), not measured"},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--off", default="approx4_mech_off_w1")
    ap.add_argument("--on", default="approx4_mech_on_w1")
    ap.add_argument("--instr", default="approx4_mech_on_w2", help="instrumented window(s), comma-separated; later ones replace segments")
    ap.add_argument("--ref", default="approx4_off_w2,approx4_off_w3", help="block-2 windows with the copy-write types")
    ap.add_argument("--parts", default=os.path.join(common.TIMING, "parts.json"), help="for k_db")
    ap.add_argument("--out", default=os.path.join(common.RAW, "mechanisms.json"))
    ap.add_argument("--cc-off", default="", help="caller cache reference (default: --off)")
    ap.add_argument("--cc-on", default="", help="caller cache on, production config (approx3_mech_cc_w1)")
    ap.add_argument("--cc-instr", default="", help="caller cache on, instrumented (approx3_mech_cc_w2)")
    a = ap.parse_args()
    P = json.load(open(a.parts)) if os.path.exists(a.parts) else {}
    r = analyse(a.off, a.on, a.instr, [x for x in a.ref.split(",") if x], P,
                (a.cc_off or None, a.cc_on or None, a.cc_instr or None))
    json.dump(r, open(a.out, "w"), indent=1)
    print(json.dumps(r["parameters"], indent=1))
    print(a.out)


if __name__ == "__main__":
    main()

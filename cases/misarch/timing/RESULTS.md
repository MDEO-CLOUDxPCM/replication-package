# Timing campaign on today's cut: results (approx4, misarch-kotlin d569ad9)

The campaign (README.md) on misarch-kotlin main d569ad9 (all 17 services in one Kotlin style, one initial migration
per database): images `:cut-20261101` (main, blocks 2 and 7),
`:timing-20261101` (timing-instrumentation b4f00b2, blocks 3, 4b, 5), `:mech-20261101` (timing-mechanisms db170f4,
block 6), the plans of plans/approx3 and the data baseline of data/README.md (converted to the squashed migrations,
data/conversion/), payment's quarter-hour jobs kept out of every measured phase. Run 2026-11-01 09:24–18:54 (9.5 h;
dry run 10.3 h), then the re-run of the segments a host-side slow episode had hit (20:50–22:35, `run-rerun.sh`,
windows `approx4_rerun_off`, `_on`, `_mech_on`).

Outputs: `timing/parts.json` (schema version 3), `timing/latency_fit.json`, `timing/RESULTS-checks.md`, gitignored
`timing/raw/` (windows, `factorial.json`, `mechanisms.json`, `sensitivity.json`, `checks.json`, `volumes.json`,
`speed.out`); all from `timing/analysis/analyse_pass.sh approx4`.

## 0. Summary

| Topic | Result |
| --- | --- |
| Run | 16 of 16 windows valid plus 3 re-run windows; **0 request errors in the 177,531 requests** of the isolation, factorial, mechanism, latency and re-run windows. At-load: 1 error in 132,563 requests at levels 0.25–0.75; from level 1.0 the load client runs out of file descriptors (the analysis uses ≤ 0.75). |
| Scheduled jobs | Kept out of the measured phases by the harness: `scheduledJobsCheck` 0 in every window. A firing costs **7.8 ms payment + 3.9 ms payment-db**. |
| Machine | Five host-side slow episodes (×1.30–1.38 on every container for 2.5–10 min; §9). The segments they hit (products, products.anon, createUserAddress off; five on types; four mechanism segments) were re-run and replace the disturbed ones. One partly hit segment is left: product (off_w1, ~+12 %; its re-run ran into another episode and is set aside, §9). |
| Parts | 105 operations, 37 request types; access and own CPU from the counters for every (request, service) pair with accesses; profile coverage median 0.94 (quartiles 0.90–0.97), counters coverage 0.68 (0.51–0.83), unmatched CPU median 0 (max 11 %). |
| Factorial (§3) | OLS: per extra item **+2.5 ± 1.3 ms** app CPU, coupon **+6.3 ± 2.5**, unit −0.5 ± 0.5 (0); payment methods not resolved (PREPAYMENT −2.0 ± 3.3, CREDIT_CARD −4.7 ± 3.3). Residual SD 5.5 ms: no disturbed cell, Huber agrees (item +1.9 ± 1.3). |
| k_c at load (§4) | Order path 1.08–1.23 (invoice 0.90), read path: gateway 1.16, catalog 0.98, user 1.19, review 0.64; DBs quartiles 1.02–1.19, sidecars 0.93–1.01. |
| Mechanisms (§5) | Copy read 0.14 ms DB per statement; copy write 1.08 ms app + 0.32 ms DB per event, delivery 2.69 ms sidecar CPU; entity-cache hit 0.71 ms provider CPU; caller cache: provider saving per hit 5.0–6.3 ms, caller miss overhead 0.64 ms. |
| Envelope (§6) | Per event handler 3.7–4.1 ms CPU (quartiles; 2.69 of it the subscriber's sidecars) against 0.34–0.88 ms of work. |
| Latency (§7) | Latency-only waits: 0.26 ± 0.07 ms per statement, **3.53 ± 0.55 ms per commit, 2.81 ± 0.43 ms per publish**, residual SD 1.6 ms (n 24). End to end at low load: reads median −16 %, none above 30 %; mutations from CPU parts alone −38 %, **with the fitted waits median 8 %, 2 of 26 above 30 %** (uploadMedia −54 %, registration −35 %). |

## 1. What was measured

Windows (plans/approx3): block 2 off_w1–w3 (production build, all 38 types), block 7 atload_w1, block 6
mech_off_w1, mech_cc_w1, mech_on_w1 (production) and mech_on_w2, mech_cc_w2 (instrumented), block 3 on_w1–w3
(instrumented: async-profiler, spans at 0.1, pg_stat_statements, counters), block 4b fo_w1–w3 (22 factorial cells),
block 5 latency_w1. Before a phase that a quarter-hour firing would overlap, the load generator holds at zero load
(`<segment>:hold`, calibration/scripts/cronjobs.py; ~17 min over the pass). Re-run windows (plans/rerun4,
README.md §4.2): `approx4_rerun_off` (products, products.anon, address.createUserAddress), `approx4_rerun_on`
(user.updateUser, adminUpdateProduct, catalog.updateProductVariant, registration, createShoppingcartItem, createOrder,
placeOrder), `approx4_rerun_mech_on` (wishlist fill, wishlistView.hot/.cold, discount.createDiscount/.updateDiscount).

createOrder and placeOrder, measured twice (on_w2 and the re-run), agree within ±3 %.

On/off overhead (instrumented vs production totals; production values are always the off totals x shares): apps
median +9 % (quartiles 0–17 %), DBs median +48 % (18–88 %; pg_stat_statements and the per-statement counters).

## 2. Parts of the relational code

Per operation, accesses as `mode:class calls, DB ms, mapping CPU ms` (parts.json `operations`):

| operation | own ms | accesses |
| --- | ---: | --- |
| order.createOrder | 3.62 | w:OrderItem 1.19, 0.64, 0.21; w:Order 1.00, 0.43, 0.34; r:User 1.00, 0.15, 0.28; r:ProductVariant, UserAddress, TaxRate, ShipmentMethod 1.00, 0.07–0.12 db each |
| order.Order.orderItems | 0.56 | r:OrderItem 1.00, 0.20, 0.29 |
| order.placeOrder | 1.57 | w:Order 1.00, 0.33, 0.28; r:Order 1.00, 0.31, 0.50; r:OrderItem 2.00, 0.44, 0.30 |
| shoppingcart.ShoppingCart.shoppingcartItems | 0.67 | r:ShoppingCartItem 1.00, 0.27, 0.38 |
| wishlist.wishlist | 1.44 | r:Wishlist 1.01, 0.20, 0.44 |
| wishlist.Wishlist.productVariants | 0.95 | r:ProductVariant 2.01, 0.40, 0.49 |
| wishlist.updateWishlist (addToWishlist) | 3.08 | w:Wishlist 3.02, 0.81, 0.43; r:Wishlist 1.01, 0.23, 0.50; r:ProductVariant 1.01, 0.22, 0.17 |
| wishlist.createWishlist | 2.83 | w:Wishlist 2.03, 0.93, 0.28; r:ProductVariant 2.03, 0.36, 0.54; r:User 1.01, 0.15, 0.11 |

placeOrder reads its Order once, updateWishlist makes three link writes. Not measured: `order.on:shipment/shipment/creation-failed`
(no request triggers the compensation), `pg_advisory_xact_lock` (0 ms as an access), and the two writes measured only
inside another statement (registerCoupon's Coupon, payment's validation-succeeded OrderItem; README.md §4.3).

## 3. Order-path factorial (block 4b)

22 cells in 3 windows, model y = b0 + item (i−1) + unit i(q−1) + coupon + PRE + CC + s600 (base: one item, one unit,
INVOICE, no coupon, stock 60). Every cell ran in the fast regime; OLS (`fits`) is used downstream, Huber
(`fitsRobust`) shown for comparison.

| term (ms per order) | apps CPU (OLS) | apps (Huber) | DBs CPU (OLS) | sidecars (OLS) |
| --- | ---: | ---: | ---: | ---: |
| b0 | 84.2 ± 3.2 | 84.4 ± 2.9 | 47.4 ± 5.1 | 61.8 ± 0.8 |
| item | **+2.48 ± 1.33** | +1.86 ± 1.25 | +3.42 ± 2.11 | +0.05 ± 0.34 |
| unit | −0.45 ± 0.54 | −0.15 ± 0.50 | −0.64 ± 0.85 | +0.46 ± 0.14 |
| coupon | **+6.27 ± 2.48** | +5.94 ± 2.30 | +2.86 ± 3.95 | +1.44 ± 0.64 |
| PREPAYMENT | −1.95 ± 3.35 | −1.95 ± 3.03 | +3.13 ± 5.33 | +1.03 ± 0.87 |
| CREDIT_CARD | −4.74 ± 3.35 | −4.66 ± 3.02 | +1.17 ± 5.33 | −0.16 ± 0.87 |
| stock 600 | −4.00 ± 4.95 | −4.47 ± 4.41 | +14.24 ± 7.88 | −1.88 ± 1.28 |
| residual SD | 5.47 | 4.86 | 8.71 | 1.42 |

Per container on the order path (2 SE; these enter the at-load cardinality term): item discount +0.63, inventory
+0.59, shipment +0.56, return +0.42, inventory-db +0.63, shipment-db +0.29, return-db +0.29, order-db +0.21,
discount-db +0.20; coupon discount +1.89, order +1.86, discount-db +0.62, order-db +0.40. Statements per extra item:
inventory +1.91, return +1.88, shipment +1.85, order +1.35, discount +1.00; Payment-method and stock terms are not resolved and not used. Latency per order:
createOrder 42.6 ms (+2.3 with a coupon), placeOrder 16.9 ms.

## 4. At-load scale k_c (block 7, levels 0.25–0.75)

Levels 0.25 / 0.5 / 0.75 = 118 / 240 / 364 requests/s (1.9 / 3.9 / 5.8 orders/s). k_c = measured container CPU at
load / predicted from the isolation parts (with the factorial's cardinality term):

| path | k_c |
| --- | --- |
| order path | order 1.19, shipment 1.09, shoppingcart 1.17, payment 1.08, return 1.11, inventory 1.10, discount 1.23, invoice 0.90 |
| read path | gateway 1.16, catalog 0.98, review 0.64, user 1.19 |
| DBs (quartiles) | 1.02 / 1.05 / 1.19 |
| sidecars (quartiles) | 0.93 / 0.97 / 1.01 |

## 5a. Scheduled jobs

payment.job:checkOpenInvoicePayments and checkOpenPrepaymentPayments (`0 */15 * * * *`, both at once) fire every
quarter hour. The harness holds the load so that no firing falls into an idle, pre, warm or steady phase
(README.md §4.2); calibration's CpuData still masks every firing, and parts.json `scheduledJobs` records the cost
against the unloaded system: **7.8 ms payment + 3.9 ms payment-db CPU per firing of both jobs** (6 firings in the
off windows); its query does not scan (no `scanSuspects` entry). On average 0.00001 cores: not in the model.

## 5. Mechanisms (block 6)

| parameter | value | unit |
| --- | ---: | --- |
| replicaReadDbMs | 0.141 | DB ms per copy read statement (0.57 per createOrder) |
| replicaReadCpuMs | 0.590 | app CPU per createOrder answered from copies (net) |
| replicaWriteCpuMs | 1.083 | app CPU per delivered copy event |
| replicaWriteDbMs | 0.321 | DB ms per copy upsert |
| deliverCpuMs | 2.693 | subscriber sidecar CPU per delivered event |
| cacheHitCpuMs | 0.713 | provider CPU per entity-cache hit (orderTracking 0.77, wishlistView 0.65) |
| cacheMissOverheadCpuMs | −0.14 | provider CPU per miss on top of the uncached call (orderTracking 1.53, wishlistView −1.81: noise around 0; not in the model) |
| callerCacheMissOverheadCpuMs | 0.639 | caller CPU per caller-cache miss |
| callerCacheSidecarSavingMs | 1.189 | caller sidecar CPU saved per hit |
| callerCacheProviderSavingMs | 5.0–6.3 | provider app + DB + sidecars per hit (shipment 5.25, discount 6.31, inventory 5.00) |

Caller cache (mech_cc_w1/w2 against mech_off_w1): hit ratio 0.996–0.997 for the hot triples; cold (fresh cart lines)
shipment 0.54, inventory 0.79, discount 0. Local copies remove createOrder's discount call entirely (discount
3.65 → 0 ms, its sidecars 2.6 → 0.03 ms).

## 6. Envelope vs work (README.md §6)

51 event handlers: envelope 3.73 / 3.87 / 4.08 ms CPU (quartiles; dispatch ~1.0, decode ~0.17, delivery 2.69 on the
subscriber's sidecars), work 0.34 / 0.42 / 0.88 ms. Delivery hops (wall p50, e.g. address/user-address/created →
invoice): app publish 1.45, Dapr publish 0.68, broker 0.68, sidecar → app 0.66 ms. `requestOverheadCpuMs` per request
on its entry operation from the counters (e.g. address 1.20 ms on user.currentUser).

## 7. Latency at low load (block 5, RESULTS-checks.md §2)

latency_fit.py on on_w1–w3 and the re-run (fast segments, sampler 0.1): server span − CPU parts − DB exec =
a x statements + b x commits + c x publishes; a 0.26 ± 0.07, b 3.53 ± 0.55, c 2.81 ± 0.43 ms, n 24, residual SD
1.57 ms. The mutations' errors below use the same fit on per-request instead of per-execution parts (0.2573, 3.5864,
2.8399, SD 1.48); the two differ in placeOrder's order point only, whose own CPU per execution includes 1.24 ms that
per-request parts give to order's creation-failed handler, which no request runs. The compose check of latency_w1 adds CPU parts only: reads are under-predicted
by a median 16 % (none above 30 %), mutations by 38 %. Adding b per service on the path that writes and c per publish
(the waits the model adds as latency-only delays) brings the 26 mutations to median 8 % (signed +2 %), 2 above 30 %:
media.uploadMedia −54 % (object store) and registration −35 % (Keycloak).

## 8. Method as run

```
timing/run-fourth-pass.sh                 # the pass
timing/run-rerun.sh                       # the disturbed segments again (plans/rerun_plans.py -> plans/rerun4)
timing/analysis/analyse_pass.sh approx4   # everything below, re-run windows listed after the pass's own
```

analyse_pass.sh: per-window caches (profile_buckets, counters, queries, envelope), factorial.py (OLS), parts.py
(off: off_w1–w3 + rerun_off*, on: on_w1–w3 + rerun_on*, at-load), mechanisms.py (instrumented: mech_on_w2 +
rerun_mech_on), sensitivity.py, parts.py again with both, latency_fit.py, compose_check.py, volumes.py, speed.py. A
type measured in two windows takes the later one (parts.py, latency_fit.py, mechanisms.py). 81 analysis tests pass.

## 9. What is approximate, and what is open

**Host-side slow episodes.** Five in the windows of 2026-11-01: 10:00–10:05,
≤ 11:02–11:05, 14:15–14:20, 16:00–16:10, and from 23:16:22 (the product re-run). Each is a step of ×1.30–1.38 on every container (Dapr placement 25–31 →
34–42 ms/s) with nothing in the VM: busy = container CPU, steal ≈ 0, no foreign process, no journal, timer or kernel
event, no agent session. Four start 17–82 s after a quarter hour, but only 3 of 21 firings of the payment cron are
followed by one, so the cron is not the trigger; the cause is on the Windows host. The
placement probe is comparable within a stack start only (the re-run's off stack sat at 30.5 ms/s with fast-regime
totals).

| caveat | finding | consequence |
| --- | --- | --- |
| product (off_w1) | its local baseline and the first 35 % of its steady phase in the 10:00 episode | ~+12 % on one read type (catalog k ~×1.01, review ~×1.02 at load); its re-run (approx4_rerun_off2, 23:15) ran into a sixth episode from 23:16:22 (catalog 3.57) and is set aside (`approx4_rerun_off2.slow-20261101`), the original kept |
| createUserAddress off total | re-run 11.65 ms apps (address 4.86, invoice 2.95), above its instrumented total (address 4.18), where instrumented totals are usually the higher (§1) | single-replicate noise of the off measurement, kept |
| registration | 3 requests/s for 45 s: shares and notification's CPU vary between runs (notification on 7.49 ms re-run, 4.81 on_w2; r_c notification 0.55) | registration's split is the noisiest of the 37 types; notification's r_c only scales the checks |
| DB totals ≤ 0 | registration's discount-, invoice-, notification- and wishlist-db totals came out at −0.07 to −0.10 ms (background noise around a small write at 3/s) | their User writes take exec × k_db instead (segment, else container, else all DBs' median; `D_dbFrom`): 0.40–0.59 ms, as the other user-created handlers |
| factorial payment methods, stock | ±3.3 / ±5.0 ms | not resolved, not used |
| entity-cache miss overhead | −1.81 (wishlistView) / +1.53 (orderTracking) ms | noise around 0, not in the model |
| compensation handler | no request reaches it | envelope-only estimate (pooled handler envelope, §6) |

Still approximate: **one replicate** per window (typical type-to-type spread between two measurements of the same
plans, ±5 %); the item effect 1.9–2.5 ms (OLS vs Huber, ±1.3); the two writes measured only inside another statement keep
the estimate; the absolute CPU ms belong to this host's clock settings, the model's relative results do not depend
on them.

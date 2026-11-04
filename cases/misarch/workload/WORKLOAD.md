# Session usage model and load variation

The session usage model of the case and its day profile (the documentation of the derivation: `../../../docs/model.md`). Files:

| File | What |
| --- | --- |
| `sessions.json` | the machine-readable session model: requests (A's ids, msa names), think times, fragments, session classes, cardinalities, data volumes, mixes, profiles, sources |
| `../generator/gen_sessions.py` (with the core's interpreter `core/generator/sessions.py`) | checks (`--check`), PCM usage-model text (`--pcm`), SimOxide load profile (`--loadprofile`) |

**Keys.** A session's steps call **requests**, keyed by the ids of A, the domain extraction
(`domain/misarch-domain.json`):
- **round-2 documents.** For these the key is A's request type, the round-2 loadgen document
  (`products`, `product`, `users`, `address`, `createOrder`, `orderTracking`, ...). Its
  `operations` are A's plan for it: root field, field resolvers and `_entities` joins, e.g.
  `product` → `catalog.product`, `catalog.Product.categories`, `catalog.Product.defaultVariant`,
  `review._entities.ProductVariant`, `review.ProductVariant.averageRating`,
  `catalog.Product.variants`.
- **Other requests.** The key is A's root operation id (`user.updateUser`,
  `return.createReturn`, ...).
- **Two own ids.** `notifications` is planned by analogy with `address`, and `registration` is
  Keycloak → `user.on:user/user/create`.
- **The msa name is the secondary key** (`requests.<id>.msa`). The PCM sketch uses it for its
  signatures, and it drives the round-2 comparison.
- **`login`** is Keycloak's password grant, the Gatling "Get Access Token" request.

`--check` prints rates per request, per A operation and per msa operation.

## 1. In brief

- **Users are sessions.** Session arrivals are open (Poisson). Within a session, the user waits
  for each response and then thinks: think times between pages, short pauses between the
  requests of one page, and probabilistic branches and loops. In PCM this is one `UsageScenario`
  per session class, with an `OpenWorkload` and a `ScenarioBehaviour` built from
  `EntryLevelSystemCall`, `Delay`, `Branch` and `Loop`. SimOxide supports all of these.
- **Five classes**, each its own scenario:
  - `browser`: anonymous window shopper.
  - `cartAbandoner`: browses, logs in, puts items in the cart and leaves.
  - `buyer`: the same, then checks out.
  - `account`: returning customer doing account tasks.
  - `admin`: employee maintaining the catalogue; constant rate.
- **Two workloads.**
  - `realistic` uses the classes above with a mix per phase (browsing, shopping, ordering),
    anchored to the three TPC-W mixes.
  - `round2` is round 2's load rewritten as one Gatling-shaped session plus admin. Its rate per
    operation equals round 2's exactly, which `--check` verifies. It is used for validation and
    comparison.
- **Design load.** In the shopping mix, 88.4 sessions/s send as many client requests (486/s) as
  round 2 at its design load of 64.2 sessions/s.
- **Load over time.** The `day` profile is a compressed day of 22 minutes. Volume and mix change
  together:
  - a browsing night;
  - midday shopping with a 60-s burst;
  - a sale spike with the ordering mix, which reaches the saturation of today's cut;
  - an evening peak;
  - a browsing decline.

  In SimOxide this is a per-scenario load profile: one step function per session class.
  SimOxide supports it today; the plugin and layer 2 do not yet (section 7).
- **Common random numbers.** SimOxide branch `session-load` adds *usage streams*. With them,
  two designs simulated with the same seed see the same users: the same arrivals, paths and
  think times. Each user's requests also draw from a stream of their own. Section 6 has the
  details.

## 2. Sources

| Id | Source | What it gives |
| --- | --- | --- |
| G | MiSArch Gatling scenarios (Ceres `template_buyProcessScenario.kt`, `template_abortedBuyProcessScenario.kt`) | request order of the buy and aborted sessions; pauses U(4,10) s after the product list, U(0.05,0.15) s between the requests of one page, U(4,7) s after the cart and after the payment data, U(8,12) s before `placeOrder` |
| C | Ceres realistic 30-min run and its 12-h trace `template_realisticUserSteps.csv` (statistics recomputed here) | 34 % buy / 66 % aborted sessions; the index of dispersion of arrivals per second is 0.96 (Poisson-like); 60-s windows peak at 1.9 × the mean, 5-min windows at 1.5 ×, hourly means within ±15 % |
| R2 | round 2, the calibration's workload (msa's `GATLING_RATES`, `EXTENDED_RATES`, `KOTLIN_BUY_SHARE` and its Gatling mix; the seed model `../domain/msa/misarch-kotlin.m`) | per session: one token, products, product, users, address, createShoppingcartItem, plus 0.3433 × the four buy requests; assumed rates for the 26 operations the load tests never call; design load 64.2 sessions/s |
| TPCW | TPC-W v1.8 (2002), clause 5; page shares as reproduced by [Kaszó et al. 2006](https://conf.uni-obuda.hu/huci2006/43_Kaszo.pdf) | browsing mix 95 % browse / 5 % order interactions, shopping mix 80/20, ordering mix 50/50; think times with a mean of 7 s |
| CBMG | Menascé, Almeida, Fonseca, Mendes: *A methodology for workload characterization of e-commerce sites*, ACM EC 1999 | sessions as probabilistic state machines (customer behaviour model graphs), and customer classes |
| BAY | [Baymard Institute](https://baymard.com/lists/cart-abandonment-rate): average documented cart abandonment 70.19 % (49 studies, 2023) / 70.22 % (2025) | buyers / cart sessions ≈ 0.3 |
| VEND | vendor benchmarks (Littledata, Dynamic Yield; [summary](https://www.smartinsights.com/ecommerce/ecommerce-analytics/typical-average-add-cart-conversion-rates/)) | 5-7 % of sessions add to cart, 1.4-3 % convert; not peer reviewed, used as an order of magnitude only |
| OC | Schroeder, Wierman, Harchol-Balter: *Open versus closed: a cautionary tale*, NSDI 2006 | web workloads are best modelled as partly open: sessions arrive open, and the requests within a session are closed-loop with think times |
| BURST | Mi, Casale, Cherkasova, Smirni: *Injecting realistic burstiness to a traditional client-server benchmark*, ICAC 2009; Mi et al.: *Burstiness in multi-tier applications*, Middleware 2008 | e-commerce workloads are bursty; burstiness was injected into TPC-W, controlled by the index of dispersion |
| SPIKE | Bodík, Fox, Franklin, Jordan, Patterson: *Characterizing, modeling, and generating workload spikes for stateful services*, SoCC 2010 | in a spike, volume and what is requested change together |
| DLIM | von Kistowski, Herbst, Kounev, Groenda, Stier, Lehrig: *Modeling and extracting load intensity profiles*, ACM TAAS 11(4), 2017 | load intensity as a seasonal part plus trend, bursts and noise (DLIM/LIMBO, used with Palladio) |
| A | assumption of this package | listed in section 8 |

## 3. Session classes

Each class is listed with its steps (`sessions.json` holds the exact model), its requests per
session (logins included) and its think time per session, both from `gen_sessions.py --check`.

| Class | Steps | Req. | Think | Sources |
| --- | --- | --- | --- | --- |
| `browser` | `products`; then 1-6 product pages (IntPMF, mean 2.5), each with a 30 % chance of a return to the list. No login: MiSArch serves public products to anonymous users (catalog `Query.products`, spec `catalog.md`: non-employees and anonymous users get the public products) | 4.3 | 23 s | CBMG, TPCW, A |
| `cartAbandoner` | `products`; 0-3 product pages; 3 % register (`registration`); `login`; the Gatling page (`product`, `users`, `address` 0.1 s apart); `createShoppingcartItem`; 25 % add a second item | 7.6 | 17 s | G, C, BAY |
| `buyer` | as `cartAbandoner`, then the Gatling checkout: `shipmentMethods`, `paymentInformations`, `createOrder`, `placeOrder` with U(4,7)/U(4,7)/U(8,12) s pauses. `createOrder` and `placeOrder` carry the order's cardinalities (section 3a), and the number of items is the session's own cart lines (1 or 2) | 11.6 | 38 s | G, C |
| `account` | `login`, `users`, then 1-3 tasks: order tracking, notifications, wishlist (view, add, create), review (after `orderTracking`), return (after `orderTracking`), profile, address, payment data, coupon. The task weights are round 2's assumed rates | 3.8 | 11 s | R2, A |
| `admin` | `login`, then 1-5 admin operations (weights = round 2's assumed rates) with U(10,30) s pauses; constant rate | 3.1 | 42 s | R2, A |
| `gatling` | round 2 as a session: the Gatling page sequence, buy with p = 0.3433, then with p = 0.199 one of round 2's 12 extra customer operations | 7.6 | 16 s | G, R2 |
| `gatlingAdmin` | round 2's admin operations, one per session, no login | 1.0 | 0 | R2 |

## 3a. Cardinalities and data volumes

The code leaves some counts open: items per order, quantities, coupons, payment methods
(domain/REPORT.md §9). The data-dependent accesses also need them:
- inventory's reservation, `FOR UPDATE SKIP LOCKED` per item and quantity;
- discount's `findApplicableDiscounts`, one nine-table statement per item;
- shipment creation, which runs per shipment method of the order.

These counts are **workload parameters**. `sessions.json` → `cardinalities` holds them, and they
become input `VariableUsage`s of the calls (`params`), so the derived SEFFs can loop over them:

| Parameter | Value | Source |
| --- | --- | --- |
| `items.NUMBER_OF_ELEMENTS` (createOrder, placeOrder) | the session's cart lines: 1 (75 %) or 2 (25 %), so a buyer's order has as many items as the buyer put into the cart | A; round 2: 1 |
| `quantity.VALUE` | IntPMF[(1;0.8)(2;0.15)(3;0.05)], mean 1.25 | A; round 2 / Gatling: 1 |
| `coupons.NUMBER_OF_ELEMENTS` (createOrder) | IntPMF[(0;0.9)(1;0.1)] | A; round 2: 0 |
| `paymentMethod.VALUE` (createOrder) | EnumPMF INVOICE 0.445 / PREPAYMENT 0.416 / CREDIT_CARD 0.139 | round 2's seed (KOTLIN-MODEL.md), REPORT §9 |
| provider success | 0.95 | simulation stub default; a system parameter |
| page sizes | `products` first 10 with totalCount; wishlist first 10 | request texts |

The round-2 session (`gatling`) overrides these with round 2's values: 1 item, quantity 1, no
coupon. Its rates and cardinalities therefore stay round 2's.

**Data volumes** (`sessions.json` → `data`; round 2's seed, `calibration/scripts/seed.py`) set the
rows of list accesses and the table sizes:
- 200 users and 300 products, with 1.7 variants each;
- 24 categories, 1-2 per product;
- 1.3 addresses and 2.4 payment informations per user;
- 8 discounts and 2 coupons;
- 60 stock items per variant;
- 600 reviews and 80 wishlists.

The timing campaign records the volumes per window, because they change the DB costs: inventory
and orders grow.

Think times: U(4,10) s between pages (G; its mean of 7 s is TPC-W's mean think time), U(0.05,0.15)
s within a page (G), plus the Gatling checkout pauses. These are Gatling's uniform pauses, not
TPC-W's exponential ones, because MiSArch's own load tests use them.

## 4. Mixes and the design load

The mix gives each phase its class shares. The shares are anchored to TPC-W's three mixes
(TPCW) by **order pages**: a page here is the requests between two think times, and it is an
order page if it calls anything other than `products`, `product`, `viewWishlist` or
`currentUserNotifications`. Shares are measured by sampling 20 000 sessions per class.

| Mix | browser | cartAbandoner | buyer | account | order pages (TPC-W) | order requests | logins/s | orders/s | own demand vs round 2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| browsing | 0.88 | 0.06 | 0.025 | 0.035 | 6.0 % (5 %) | 12.5 % | 11.1 | 2.2 | 57 % |
| **shopping** (base) | 0.64 | 0.18 | 0.09 | 0.09 | 19.1 % (20 %) | 32.8 % | 32.3 | 8.0 | 80 % |
| ordering | 0.24 | 0.27 | 0.27 | 0.22 | 45.9 % (50 %) | 57.8 % | 67.6 | 23.9 | 121 % |

The columns from logins/s on are at 88.4 sessions/s. "Own demand" is Σ rate × (cpuMs + dbMs) of
the msa operations, plus Keycloak's CPU per login. It ignores hops and the gateway; it is a check,
not a calibration.

- **Buyers per cart session.** The ratio is 1/3 in the browsing and shopping mixes. That matches
  Gatling/Ceres (34 % buy, G and C) and the documented 70 % cart abandonment (BAY). In the
  ordering mix (a sale) it is 1/2 (A).
- **Share of sessions that buy.** The shopping mix converts 9 % of sessions. That is between real
  shops (1.4-3 %, VEND) and MiSArch's load tests (34 %). TPC-W's shopping mix is also heavier on
  orders than real shops. A performance study needs the write path loaded.
- **Design load.** At 88.4 sessions/s the shopping mix sends 486 client requests/s (logins
  included). That is round 2's request rate at 64.2 sessions/s, and round 2's design load is
  0.6 × the measured saturation. The equivalence is in requests, not in demand. Three
  differences matter:
  - **Fewer logins: 32/s instead of 64/s.** Browsers are anonymous. In round 2 every session
    logged in, and Keycloak (2 cores) was the bottleneck of round 2's knee design.
    This change is intended and realistic, but it moves the knee.
  - **More reads.** `product` runs at 211/s instead of 64/s.
  - **Fewer orders.** `placeOrder` runs at 8/s instead of 22/s.

  The operations' own demand is 80 % of round 2's. `--check` prints the rate of every operation
  next to round 2's.

## 5. Load variation over time: the `day` profile

The profile is a compressed day (DLIM: a seasonal part plus bursts) of 1320 s. The first 120 s
warm up and are not measured. Volume is in sessions, relative to the design's 88.4 sessions/s.
The admin rate stays constant throughout.

| Time (s) | Phase | Volume | Mix | Requests vs round 2's design load | Own demand vs round 2 | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 0-300 | night | 0.6 | browsing | 51 % | 34 % | trough of the day; mostly browsing |
| 300-420 | morning | 0.8 | shopping | 80 % | 64 % | ramp |
| 420-600 | midday | 1.0 | shopping | 100 % | 80 % | the design load |
| 600-660 | burst | 1.6 | shopping | 160 % | 127 % | a 60-s burst (C: 60-s windows reach 1.9 × the mean; BURST) |
| 660-780 | afternoon | 1.0 | shopping | 100 % | 80 % | |
| 780-900 | sale | 1.3 | ordering | 167 % | 157 % | a campaign spike: volume and mix change together (SPIKE), checkout-heavy (TPC-W ordering mix) |
| 900-1080 | evening | 1.3 | shopping | 130 % | 103 % | evening peak |
| 1080-1200 | late | 1.0 | browsing | 85 % | 57 % | decline, browsing again |
| 1200-1320 | night | 0.6 | browsing | 51 % | 34 % | |

- **Mean load.** Over the measured window the mean request rate is 98 % of round 2's design load.
- **The sale phase** reaches about round 2's measured saturation of today's cut: 107/64.2 =
  167 % of the design load in requests. A design that is better than today's at the checkout
  survives the sale; a worse one queues up.
- **Day shape.** The Ceres trace itself is flat over its 12 hours (±15 %). Its source study's
  full day was not available, so the day shape here is an assumption, kept moderate (peak/trough
  2.2 in requests). The design-load level and the burst factor are measured.
- **`steady` profile.** It holds the shopping mix at the design load (600 s after warm-up), for
  stationary comparisons.

**How it maps to SimOxide.** Each class's scenario gets a step function with
`factor_c(t) = volume(t) · share_c(mix(t)) / share_c(shopping)` (`--loadprofile`; the file format
is SimOxide's `docs/guide/load-profile.md`).
- Open arrivals are scaled in operational time. A session keeps the class it arrived with.
- Sessions in progress at a phase change finish as they started. This is how a real mix change
  happens too.
- A class absent from a phase would need factor 0, which SimOxide does not accept. Every class
  therefore keeps a share in every mix.

## 6. In SimOxide

The session classes are usage scenarios with `Delay`, `Branch`, `Loop` and `EntryLevelSystemCall` actions; per-operation
response times come from `SystemOperationMeasuringPoint`s; the day profile is SimOxide's per-scenario load profile
(above). Every evaluation runs with usage streams (`SimConfig::usage_streams`, fast mode): one arrival stream per
scenario and, per user, a behaviour stream (delays, branch choices, loop counts, call parameters) and a request stream,
seeded from the run seed. The same seed therefore gives the same users in every design, and a difference in one user's
requests shifts no other user's numbers; what still differs between designs is what depends on the system (response
times and, through them, the later steps of a session).

## 7. Assumptions (A) to revisit

| Assumption | Value |
| --- | --- |
| product pages per browser session | IntPMF 1-6, mean 2.5 |
| chance of a return to the list | 30 % |
| product pages before the cart | 0-3, mean 1.1 |
| second cart item | 25 % |
| registration | 3 % of cart sessions |
| account tasks per session | 1-3 |
| admin session | 1-5 operations, U(10,30) s pauses; constant 0.445 sessions/s (round 2's admin operation rate at the design load, which round 2 scaled with the load) |
| sale conversion | 1/2 |
| shape of the day | volumes 0.6-1.6, sale 1.3 |
| browsing anonymous | yes (MiSArch allows it; Gatling always logged in) |
| quantities per item, coupon share, sale conversion | section 3a |
| plan of `notifications` | by analogy with `address`; A has no round-2 document for it |

Every value is in `sessions.json`, so changing it means editing data, not code. `--check` shows
the effect.

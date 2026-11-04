# Timing campaign data baseline

Every window starts from the same data state: a baseline loaded with the profile of `profile.json` and snapshotted as
`<svc>_baseline` template databases; `reset.sh` restores it in **~28 s** with the stack up. The measured snapshot was
loaded on misarch-kotlin f05d898 (`--mode off`) and carried forward to the measured code by `migrate-baseline.sh`
(201e2e7's migrations, then the conversion to d569ad9's squashed migrations, `conversion/README.md`);
`baseline_migrations.json` records its migrations, `baseline_counts.json` its row counts.

| Path | What |
| --- | --- |
| `profile.json` | target profile. Top level = the loaded profile. `reduced` = the overrides of a smaller profile (not loaded) |
| `load_baseline.py` | the loader: API stages for small classes, COPY stages for bulk classes (`all` or one stage) |
| `check_baseline.py` | consistency check: every copy against its owner, order history copies; row counts / compare |
| `reset.sh` | `snapshot` (once, after loading), `reset` (before each window), `verify` |
| `kc_clean.py` | deletes every Keycloak user except the session pool (used by reset) |
| `baseline_counts.json` | exact row count of every table of the 15 service databases in the baseline |
| `baseline_migrations.json` | each service's applied migrations in the snapshot (`conversion/convert.py record`) |
| `migrate-baseline.sh`, `conversion/` | carry the snapshot forward to new images' migrations (`conversion/README.md`) |
| `baseline/` | generator files of the baseline (seed state, setup.json, pools.json, pools-ext.json), `api.json` (ids created through the API), `load-log.json` (per-stage durations and rows), `seed.log` |

## Profile (loaded)

The top level of `profile.json`: small tables exactly as profiled, bulk classes at full size.

| Class | Loaded |
| --- | --- |
| shipment methods | 15 |
| tax rates / versions | 6 / 18 (3 each; the last keeps today's rate) |
| categories / characteristics | 300 / 1,423 (new ones: 5 each — Brand, Colour, Material, Size, Weight; seed's 24: 2) |
| discounts / coupons | 50 (+ the requests' sink) / 500; 12 discounts coupon-bound; 9,784 coupon redemptions |
| products / variants / versions | 50,000 / 85,058 / 169,368 (1–2 categories, 1.7 variants, ~2 versions each) |
| media | 49,620 RustFS objects (1 per bulk product, linked to the default variant's versions) |
| stock | 1,885,400 IN_STORAGE (20 per bulk variant; 300 per pool variant; 60 / 600 factorial) + 713,354 DELIVERED + 14,708 LOST |
| users / addresses / payment infos | 100,000 / 130,155 (1.3) / 239,898 (2.4: prepayment + invoice + 40 % credit card) |
| orders / items | 300,000 (3 per user) / 375,215 (1.25), quantity 1–3; 290,928 placed, 9,072 pending |
| shipments | 290,928 order shipments (98 % delivered, 5,835 failed with items LOST) + 8,516 return shipments |
| returns | 8,516 (3 % of placed orders) |
| reviews / wishlists | 50,000 / 20,000 (~8 entries) |
| notifications | 499,670 (Poisson 5 per user) |
| open carts | 5,000 users, 10,329 lines |

Total size of the 15 service databases: 3.16 GB (inventory 906 MB, payment 574 MB, invoice 456 MB, catalog 326 MB,
order 206 MB, shipment 199 MB, notification and return 137 MB each, the rest < 50 MB each); 10.9 M rows. The
snapshot (`<svc>_baseline` template databases) doubles that, and a reset needs a third copy of one database at a time.
**Disk:** after the snapshot 14 GB were free on `/`. `timing-up.sh up` refuses
below 15 GB, so free some space before the next `up` (each Postgres also grows its `pg_wal` back towards
`max_wal_size` = 1 GB under write load).

## How it was loaded

Durations are those of the load of the measured snapshot.

1. **Empty databases.** The 15 service DB volumes and the RustFS volume are deleted, and Flyway recreates the schemas
   at app start. Keycloak keeps its volume; users other than the session pool are removed (`kc_clean.py`).
2. **Pool through the API.** This is how MiSArch creates these entities, so events fill every copy.
   - `calibration/scripts/seed.py` (`--stack kotlin`) creates the pool: 200 buyers, 300 products, 24 categories,
     3 tax rates, 3 methods, 8 discounts, 2 coupons, 600 reviews, 80 wishlists, with `--stock 300` (`seed.py --stack
     kotlin --out calibration/results-kotlin/seed/state.json --stock 300`, all else default; `baseline/seed.log`). 151 s.
   - `requests/run.py setup` (after removing `timing/state/setup.json` and `pools-ext.json` and calibration's
     `results-kotlin/pools.json`, which it would otherwise reuse) created the factorial buyers, coupon0
     registrations, sink, registration coupons, factorial products and stock 60/600. It took 455 s.
   - Keycloak users are reused (409 → same id), so **buyer, fbuyer and gatling ids are unchanged**. Catalogue, address
     and payment ids are new.
3. **`load_baseline.py api`** (317 s, mostly the uploads; remove `baseline/api.json`, `load-log.json` and
   `placed-pool.json` first, the stage skips what `api.json` lists): through the API, 3 more tax rates, 2 more
   versions for each rate, 12 shipment methods, 275 categories and 49,620 media uploads. It waits until every copy has arrived.
4. **Bulk stages**: COPY with `session_replication_role=replica` (no triggers or FK checks; the check verifies instead).
   Rows are written to TSV first. Ids are deterministic (seeded RNG).
   - `catalog` 24 s.
   - `users` 5 s.
   - `discounts` 11 s: 42 discounts and 478 coupons through the API, plus redemptions and usages.
   - `orders` 49 s.
   - `misc` 7 s.
   - `finish` 27 s: wait for Redis, trim, `VACUUM (FREEZE, ANALYZE, PARALLEL 0)` (a parallel vacuum of inventory
     needs more than the containers' 64 MB `/dev/shm` at full size).

   Total load time from empty databases is about 18 min (seed 2.5, setup 7.5, api 5.3, bulk 2.2). Afterwards delete
   `tsv/` (1.9 GB) and, to shrink `pg_wal` (5 GB after the load), run `SELECT pg_switch_wal(); CHECKPOINT` ~60 times
   per database.
5. Every bulk class is written with **every copy** that the services' event handlers would write, with the formats of
   API-created rows:
   - **users:** address/discount/notification/review/wishlist `UserEntity`, `shoppingcart.userentity`, `order.users`
     (address ids), `invoice.users`;
   - **addresses:** `invoice.user_address`, `shipment.addressentity`;
   - **variants and versions:** `discount.productvariantentity`/`productentity`/`producttocategoryentity`,
     `inventory.productvariantpartialentity`, `order.product_variants` (current version, price, tax rate),
     `review.products`/`product_variants`, `shoppingcart`/`wishlist` variants, and the return/shipment
     `productvariantversionentity` for all versions;
   - **orders:** the saga's results:
     - payment: `paymententity` SUCCEEDED, plus `openorderentity` with the order JSON;
     - invoice: the markdown invoice, with address JSON;
     - shipment: shipment, `orderitementity`, links;
     - return: `orderentity`, `orderitementity`, `shipmententity`;
     - inventory: sold items DELIVERED or LOST, with the order id;
     - discount: `discountusageentity`.
6. **Pools** (`load_baseline.py pools`):
   - Every seed buyer got one delivered order from the last 5 days. Those orders are pools.json `placed`, for
     orderTracking and createReturn.
   - `run.py prep` built the returnable pool (200) and the reviewed pool.
7. **Snapshot**: `reset.sh snapshot`.

Approximations:
- Discount application in the history: automatic (coupon-free) discounts valid at the order date, applied
  multiplicatively. History orders use no coupons.
- Shipping fee: base + per item × count + per kg × weight.
- History orders use the tax rate's current version. Pool products' versions are dated today, while their history
  orders are up to a year old.
- Payments in the history never fail.
- One shipment per order: all items share the shipment method.
- The bulk data contains no archived addresses and no user gender or birthday.
- MiSArch artefact: the shipment copy's `version` of the 110 API-created addresses differs from the address
  service's. The bulk rows match; the check ignores `version`.
- Bulk products are spread over all categories except the sink. The pool's 24 categories therefore also hold bulk
  products: the coupon0 discount applies to more products. The 42 new discounts are only on new categories and bulk
  products.
- Reviews, wishlists and carts are by bulk users only, so the pool's reviewed and cart logic stays as it was. All
  users have notifications.

## Consistency check (`check_baseline.py`)

40 checks, all OK on the baseline (full profile, 12 s) and again after a reset:
- every copy table equals its owner (users ×8, addresses ×4, tax rates ×2, categories, products ×2, product
  categories, variants ×6, versions ×2, shipment methods, coupons, media links);
- placed orders = open orders = invoices = order shipments = return orders;
- placed items = shipment items = return items;
- sold inventory items per order = sum of the item counts;
- payment amounts = order amounts;
- discount usages ⊇ history.

Full baseline: reset, then `requests/run.py smoke --n 3`: all 36 types plus the 2 anonymous variants, 3 times each,
0 failures, no app restarts; then reset again (27 s). 

## Reset (`reset.sh`) — 25–30 s

```
bash timing/data/reset.sh        # from the repository root (it resolves its paths from its own location)
```

Run it with the stack up, outside measurement windows (it refuses while `MEASURING.lock` exists); the caller holds
`STACK.lock`. No app restarts. Steps:
1. **Databases, ~9–12 s.** Per service DB, one after the other:
   `CREATE DATABASE <svc>_new TEMPLATE <svc>_baseline STRATEGY FILE_COPY`, then `DROP DATABASE <svc> WITH (FORCE)`,
   then `ALTER DATABASE <svc>_new RENAME TO <svc>`. The data come back frozen and analysed (planner statistics
   included). Running these in parallel once made 5 of 15 Postgres servers restart (a backend got SIGQUIT, exit code 2)
   during the snapshot, so the steps run sequentially.
2. **Keycloak.** Users other than gatling, buyer\*, fbuyer\* are deleted through the admin REST API (registration's
   users).
3. **Generator files** back to `baseline/`: calibration `results-kotlin/seed/state.json` and `pools.json`, and
   `timing/state/setup.json` and `pools-ext.json`. `tokens*.json` are kept: the user ids did not change.
4. **Redis**: `redisq.py trim`. If the stack runs `--mode on` (pg_stat_statements preloaded), `stackctl.py ext`
   re-creates the extension.
5. **Heal and verify, ~12 s.**
   - The apps' R2DBC pools still hold connections to the dropped database. Payment halts its JVM on an unhandled DB
     error (as the NestJS original does), which would also break its sidecars' network namespace.
   - So: 24 concurrent `/health` calls per round for the 8 apps whose health checks the DB, then 16 concurrent copies
     of 9 GraphQL queries covering all services, until 3 clean rounds. A dozen requests fail on the way, which is
     expected. "… not found" answers count as clean: in the full baseline gatling has a PENDING history order, whose
     `invoice` is not found (as in the real saga), and the invoice app answered from its database.
   - If an app restarted anyway, its `-dapr`/`-ecs` sidecars are recreated and the limits re-applied.
   - Finally, the row counts must equal `baseline_counts.json` (`--no-verify` skips this, ~2 s).

**Not reset:**
- RustFS objects: uploadMedia adds a few per window, and no measured request lists or reads media;
- Keycloak's in-memory sessions;
- JVM state and caches: the harness warms up anyway.

## Integration notes (for the harness)

- **Do not run `maintain.py`'s cart cleanup after a reset.** It deletes the baseline's open cart lines. Restock
  is not needed either: the pool's variants have 300 items, the factorial groups 60/600. `run.py stock`, `prep` and
  `cleanup` are unnecessary after a reset, because the pools and archived methods come from the baseline. They are
  harmless.
- **Generator files** belong to the snapshot: `calibration/results-kotlin/seed/state.json`, `pools.json`,
  `timing/state/setup.json`, `pools-ext.json` (copies in `baseline/`). `reset.sh` restores them before every window.
- **Block 6 (mech images).** order's migration `V2__local_copies` (`LocalCopy*Entity` tables; after the squash it follows
  `V1_1__create_relations`) is not in the snapshot, which was taken on cut images. After a reset,
  harness/migrations.py applies it from the running image (campaign.py `SNAPSHOT_MAY_LACK`) and
  harness/mech_backfill.py fills the copies.
- The snapshot was taken with `--mode off`. The baseline databases do not contain pg_stat_statements; `reset.sh`
  adds it under `--mode on`.
- Reloading from scratch:
  1. delete the volumes;
  2. bring the stack up on the images to measure (`timing-up.sh up --mode off`);
  3. seed with `calibration/scripts/seed.py --stack kotlin` (params in `baseline/seed.log` / `profile.json` `pool`);
  4. `run.py setup`;
  5. `load_baseline.py all` (the profile = `profile.json`'s top level; the loader writes the unified schema's table and
     column names);
  6. `reset.sh snapshot` (writes `baseline_counts.json` and copies the generator files to `baseline/`), then
     `python3 conversion/convert.py record baseline_migrations.json`.

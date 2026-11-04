# Baseline conversion to the squashed migrations

misarch-kotlin replaced the Flyway history of all 15 database services by one `V1_1__create_relations.sql` each, in
one SQL style (docs/PORTING.md §6; branch `unify-squash`, from `unify` 786f33c). The measured data baseline (the
`<svc>_baseline` templates of `../reset.sh`) was taken at main 201e2e7 and carries the old history. A Flyway at app
start would refuse it (applied migrations not resolved locally), so `../migrate-baseline.sh` converts those databases
before the stack starts.

| Path | What |
| --- | --- |
| `<svc>/old/V*.sql` | the service's migrations before the squash, byte-identical: unify 9e4cd77 for inventory, invoice, order, payment, review, shoppingcart, wishlist (their first squash came later); unify 786f33c for address, catalog, discount, notification, return, shipment, tax, user (incl. unify's V2/V3). The snapshot has the first ones (versions below). They are the conversion SQL: the ones a database's history lacks are applied, data conversions included (e.g. review's rating names, invoice's address ids, inventory's TEXT -> UUID with its pre-check, shipment's link deduplication) |
| `<svc>/cleanup.sql` | the deliberate clean-ups: the old set's final schema -> the new `V1_1` (below) |
| `<svc>/squashed/`, `<svc>/restyle.sql` | invoice and wishlist only: the first squashed `V1_1` (786f33c) and its step to the current one, for a database converted in between (none is known; the other five first-squash files are unchanged) |
| `convert.py` | `status`, `convert`, `record`, `needs-migration` (docstring) |
| `test/` | `run.sh`: the synthetic test (throwaway `postgres:16`), `seed/<svc>.sql` rows written with the snapshot's schema, `check/<svc>.sql` assertions on the converted data (`*-squashed.sql`: the restyle step) |
| `../baseline_migrations.json` | written by `convert.py record` after `reset.sh snapshot`: each service's applied migrations (version, script, checksum) and the hash of `baseline_counts.json`; `run-fourth-pass.sh` compares it with misarch-kotlin main |

Snapshot versions (main 201e2e7): inventory, invoice, order, payment, review, wishlist V1-V2, shoppingcart V1;
address V1_1-V1_3, catalog V1_1-V1_6, discount V1_1-V1_3, notification V1_1-V1_2, return V1_1-V1_2, shipment V1_1-V1_7,
tax V1_1, user V1_1-V1_2.

## How `convert.py convert --images TAG` works

Per service, in its Postgres container (`misarch-kotlin-<svc>-db-1`; the apps are not running):
1. The new migration set comes from the image `misarch-kotlin/<svc>:TAG` (`/app/BOOT-INF/classes/db/migration`, copied
   with `docker create` + `docker cp`). If it does not start with a `V1_1__create_relations.sql` that differs from
   `old/`'s (images before the squash), there is nothing to do.
2. `<svc>_conv` = a file copy of `<svc>_baseline`. Its `flyway_schema_history` must be a prefix of `old/` (version,
   script and Flyway checksum), exactly `squashed/`, or already the new set; anything else stops with "unknown" and
   changes nothing.
3. One transaction on the copy: the old migrations the history lacks and `cleanup.sql` (after `squashed/`:
   `restyle.sql`), then `flyway_schema_history` is replaced by the row Flyway writes for the new V1_1 (rank 1, version
   `1.1`, description `create relations`, type SQL, script, checksum = Flyway's CRC32 from `harness/migrations.py`,
   success; installed_by/installed_on of the old first row).
4. Verification, any difference fails loudly: an empty `<svc>_fresh` is migrated with the new V1_1 by the Flyway CLI
   (`flyway/flyway:13.10.0`, the version misarch-kotlin uses, in a throwaway container on the database container's
   network; without the image: psql and computed checksums); `pg_dump --schema-only` of both (without
   `flyway_schema_history`) must be identical, the history rows must equal Flyway's, and `flyway validate` of the
   copy against the image's whole set must pass (later forward migrations, e.g. block 6's order `V2__local_copies`,
   may be pending). Row counts before and after are printed (deliberate deletions: inventory's "phantom" items without
   product variant, shipment's duplicate link pairs, invoice's vendor addresses with only an id).
5. Swap: the copy becomes `<svc>_baseline` (connections disallowed, as `reset.sh snapshot` leaves it), the old template
   is dropped, the live `<svc>` becomes a copy of it. A failure before this step leaves template and live database
   unchanged. Disk: transiently one more copy of the largest converted database plus its rewrite and WAL (inventory
   ~0.9 GB, rewritten by its V3: plan ~4 GB free); index builds run without parallel workers (the 64 MB `/dev/shm`).

`migrate-baseline.sh` then continues as before: stack up on the images, `reset.sh reset`, migrations newer than the
snapshot (`migrations.py apply`; none after a conversion of all 15), `VACUUM ANALYZE`, `reset.sh snapshot`,
`convert.py record`, `reset.sh verify`.

## Deliberate clean-ups (`cleanup.sql`; the only schema differences to the old sets)

All string columns are `TEXT` (address, catalog, discount, notification, return, shipment, tax, user: `VARCHAR(255)`
before; wishlist `VARCHAR`), a type-only change (no table rewrite). Further:

| Service | Clean-up |
| --- | --- |
| address | the name rule (both names or none) as `CHECK` constraint `addressentity_firstname_lastname_check` instead of the trigger `enforce_names_null_or_not_null` and its function (fails on a row with one name) |
| catalog | default names for the foreign keys `fk_product_default_variant`, `fk_product_variant_version`, `fk_tax_rate_od` (`<table>_<column>_fkey`) |
| return | the triggers `before_update_orderitem_check_return_order_match`, `check_return_trigger` and their functions dropped (ReturnService checks the same rules) |
| tax | default name for `fk_tax_rate_version` (`taxrateentity_currentversionid_fkey`) |
| discount, notification, shipment, user | only `TEXT` |
| invoice | `uuid-ossp` extension (as every service); `VendorAddressEntity.seq` -> `version` (the current vendor address has the highest version, as in address and shipment), its sequence renamed, vendor addresses with only an id deleted and the address lines `NOT NULL`; unique index `invoiceEntity_orderId` -> constraint `UNIQUE (orderId)` (`invoiceentity_orderid_key`) |
| review | unique index `reviewEntity_userId_productVariantId_key` -> constraint `UNIQUE (userId, productVariantId)` (same name); index `reviewEntity_userId` dropped (the unique one serves the lookups by userId) |
| payment | unique index `openOrderEntity_orderId` -> constraint `UNIQUE (orderId)` (`openorderentity_orderid_key`); `PaymentEntity.totalAmount` `DOUBLE PRECISION` -> `BIGINT` (fails on a fractional amount); `publicMethodDetails`, `secretMethodDetails` and `OpenOrderEntity.orderJson` `JSON` -> `JSONB`, `orderJson` renamed `orderData` |
| shoppingcart | index `ShoppingCartItemEntity_userId_idx` -> `shoppingCartItemEntity_userId` |
| wishlist | index `WishlistEntity_userId_idx` -> `wishlistEntity_userId` |
| inventory | `seq` (identity, used: the reservation takes the oldest items first) -> `insertionOrder BIGSERIAL`, values kept, the sequence continues after the largest; its unused `UNIQUE` constraint dropped; index -> `productItemEntity_variant_status_insertionOrder` |
| order | none |

## Test

`test/run.sh <misarch-kotlin checkout> <ref>` (a few minutes; needs `flyway/flyway:13.10.0`): one throwaway
`postgres:16` container, never the stack or the real snapshot; refuses while `MEASURING.lock` exists and takes no
lock. For all 15 services it builds the snapshot-state databases with the Flyway CLI from `old/`, seeds them, runs
`convert`, checks the data, runs `convert` again (no-op), checks that a rejected row (invoice V3's pre-check) and an
unknown history change nothing, converts invoice and wishlist from `squashed/` (restyle), and tests `record` /
`needs-migration` (against `unify-squash` 4207f62: all ok).

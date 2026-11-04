"""Prose of domain/REPORT.md; report.py fills the {{placeholders}} from misarch-domain.json."""

TEMPLATE = """# Domain extraction from misarch-kotlin `main`: report

The case's domain model (A; docs/model.md §3). Source: misarch-kotlin `main`, commit `{{commit}}`, read through
git (the scripts work whatever branch the working tree has checked out). This file is generated:
`python3 cases/misarch/extract/build.py` validates the curated files and writes `misarch-domain.json`,
`python3 cases/misarch/extract/report.py` writes this report (prose in `extract/report_text.py`).

## 1. How the data was obtained

Automatic (deterministic scripts in `extract/`; no hand-kept lists of tables, fields or topics):

| script | extracts |
|---|---|
| `sql_schema.py` | tables, columns, primary/foreign keys, unique constraints, indexes, triggers (and the tables their functions read/write), row sizes, from the Flyway migrations in version order |
| `sdl.py` | GraphQL root fields, resolvable entity types, resolver-like fields (`reference/sdl`); federation: entity owners, contributed fields, stubs (`reference/schemas`, which the gateway composes) |
| `persistence.py` | every method that runs SQL (Spring Data repositories with derived queries and `@Query`, SQL literals of the ported services' stores, `BaseConnection` subclasses, `R2dbcEntityTemplate`), the tables it reads and writes, statements over several tables |
| `events.py` | subscriptions (`@Topic`, subscription JSON, `dapr-subscribe.json`) with their handlers; publish sites |
| `callgraph.py` | reachability from an operation's entry to persistence methods and topics (cross-check of the curation) |
| `requests.py` | the operations and gateway joins each request of the round-2 workload runs (documents of `timing/calibration/scripts/loadgen.py`, walked against the subgraph schemas) |

Curated (`extract/curated/<service>.yaml`, validated by `build.py`): what each table is (class,
join table, copy), the references, and per operation its entry, accesses (class, read/write,
statement shape, strong, realisation today, persistence method, call site), calls, publishes,
transactions, saga role and feature. Every curated fact names code by an anchor (`file#text`),
which `build.py` resolves to `path:line` on the commit; an anchor that does not resolve is an
error. `build.py` also checks that every table, GraphQL root field, entity type and subscription
is covered, and compares each operation's accesses with what is reachable from its entry.

## 2. Counts

{{counts}}

Per service (today's owner):

{{services}}

## 3. Classes, copies, references

{{classes}}

Local copies (each one an instance of the "local copy fed by events" mechanism, not a class):

{{copies}}

## 4. Statements and transactions over several classes

Cross-class statements (one SQL statement or trigger over several tables). Only the owner's own
class tables in a statement bind classes; a statement that reads a local copy is the copy
mechanism at work, and a join table alone binds nothing (it is a reference).

{{joins}}

Transactions that write several domain classes:

{{transactions}}

## 5. Events

{{events}}

## 6. Coupling structure

Bindings: pairs of classes that a transaction, a cross-class statement or a composition ties
together today.

{{bindings}}

Most co-accessed pairs (domain operations touching both classes; rate: msa request rate at
loadFactor 1 of the mapped operations):

{{coaccess}}

Inseparable candidates and the size of the cut space:

{{atoms}}

Reading of the coupling structure:

- Classes always touched together: Order/OrderItem (`createOrder` writes the order, its items and
  their discounts in one transaction; an order read is its row and the items are read by
  `Order.orderItems` in statements of their own, before one statement over all three tables) and
  ShoppingCart/ShoppingCartItem (five transactional repository methods, the cart row is locked and
  touched with every item change). These are the hot inseparable pairs;
  splitting them means a rewrite of the statement plus a saga or a lost lock, for nothing.
- Coupon/CouponRedemption (trigger `update_coupon_usages` counts redemptions into the coupon) and
  Discount/DiscountUsage (trigger `check_discount_usages`, `findApplicableDiscounts`' statement)
  are bound by database triggers: separating them means moving the trigger logic into code.
- Catalog: Product, ProductVariant, ProductVariantVersion, Category, CategoryCharacteristic and
  CategoryCharacteristicValue are bound only by product creation (transactions, the six-table
  `findValidCategoryCharacteristics` query and its trigger) — admin traffic. The browse path
  reads them in separate statements per resolver (DataLoaders, connections). So the catalog is
  separable at a price that only the (rare) admin operations pay; a cut through it is plausible.
- TaxRate/TaxRateVersion: one transaction on admin paths, composition.
- Everything else is held together only by co-access: the domain's 31 classes form 20 groups
  with all bindings, 27 groups when only hot-path bindings count. Plausible cuts are therefore
  partitions of about 20 to 27 units (Bell numbers 5e13 to 5e20); the search space of the
  optimiser should be the 31 classes with group moves over these units (docs/search.md).
- The strongest unbound co-access pairs (rate column above): ProductVariant with User,
  ShoppingCartItem and ShoppingCart (cart), Order with ProductItem (stock check), OrderItem with
  ProductVariantVersion (price snapshot), Discount with ProductVariant (applicable discounts).
  These are where the mechanism choice (copy, call, cache) matters most.

## 7. Mapping to the msa model (seed for the timings)

{{msa}}

{{needs}}

## 8. What the timing campaign measures

Parts: per domain operation its own work, and per (operation, class, read/write) the access part
when it is local. The seed column splits round 2's calibrated demand of the mapped msa operation
(cpuMs over the mapped operations of its home service, dbMs over their accesses): a placeholder
for ranking, not a measurement.

{{parts}}

Mechanism parts (needed whatever the cut, partly measured in round 2): middleware per synchronous
call (round 2: caller 0.77, callee 1.10 ms CPU, 0.2 ms latency), gateway request and per-subgraph
fetch (2.32 / 1.10 ms), publish / broker / deliver (0.43 / 0.2 / 1.1 ms), copy write per copy
(1.67 ms CPU, 0.94 ms DB, measured in 28 request/copy pairs) and copy read (assumed 0.3 ms DB).
The 35 copy-maintenance operations of today's cut give one copy-write measurement per copy.

Expected magnitudes (round 2, per request): most accesses are single-row statements of 0.1 to
0.5 ms DB; the heavy ones are inventory's reservation (`FOR UPDATE SKIP LOCKED` per order item,
12 to 25 ms DB per reaction in msa), shipment creation (9 ms DB, provider call inside the
transaction), `findApplicableDiscounts` (one nine-table statement per order item), catalog's
product creation (six classes in one transaction) and the shipment-method listing (2.4 ms DB).

How the campaign attributes them (`timing/README.md` §3): `pg_stat_statements` entries go to
persistence methods by their SQL (the JSON lists every method's statements under
`persistenceMethods`, the accesses name their method in `via`), the application CPU per part
comes from the instrumentation build's CPU counters, and a statement shape shared by several
operations (e.g. `OrderStore.findOrder`) is split by their executions.

## 9. Ambiguities and how they were decided

- **Table vs class.** `AddressEntity` holds two GraphQL types with disjoint rows: two classes
  (UserAddress, VendorAddress). `CategoryCharacteristicEntity` / `CategoryCharacteristicValueEntity`
  hold two types each (categorical, numerical) that are always listed together: one class each.
  shoppingcart's `UserEntity` is the ShoppingCart (one cart per user, created by the
  user-created handler, so it doubles as the user copy). order's `order_item_discounts` is no class:
  it is the reference OrderItem.discounts (a join table, each row with a snapshot of the discount's
  value), the applied discounts msa embeds in the order item (`internal_discounts`).
- **Copies with own data.** return's OrderItem copy carries `returnedWithId` (the Return–OrderItem
  association that return owns) and the copied `sentWithId`; shipment's OrderItem copy carries
  `sentWithId` (Shipment–OrderItem); payment's OpenOrder copy carries `paymentId`/`orderId` (the
  Payment–Order association). They stay copies; the own columns are references of the owner's
  class (`own:` in the curated tables). return's Shipment copy keeps `deliveredAt`, which
  return derives from the first DELIVERED status (Shipment has no such attribute).
- **Operations.** GraphQL fields inherited from an abstract class (catalog's categorical and
  numerical characteristic types) are one operation per SDL field with the same entry. Shared
  subscription routes (review, order, wishlist, shoppingcart) are split per topic, anchored at the
  topic branch. Field resolvers that only read their parent object are `trivial` (no resolver
  pages an already loaded list). `hasNextPage` of the
  Kotlin originals' connections (a third statement when selected with `first`) is not modelled;
  `totalCount` is (when selected). The ports' connections (`ConnectionQuery`) list all three
  statements, page, COUNT and probe, each when its field is selected; a request plan's connection
  step records what its document selects (`selects`, `first`).
- **Statement shapes.** `saveAll` of Spring Data R2DBC issues one INSERT per element (perItem);
  `findAllById` with an empty list issues no statement (`when`); `MAX(version)` reads are strong
  single-row selects; advisory locks (shipment, payment) are `lock` accesses on the guarded class.
- **Triggers and foreign keys** are accesses of the operation that fires them (catalog lists the
  trigger reads per value row; discount the coupon counter; return the two checks), and statements
  in §4. Foreign keys from an own table into a copy (catalog's ProductVariantVersion → TaxRate copy,
  PVV–Media → Media copy, discount's FKs into its User/Product copies) mean a write checks the
  copy: such copies cannot be replaced by a call without dropping the constraint.
- **Branch probabilities** (payment method INVOICE 0.445 / PREPAYMENT 0.416 / CREDIT_CARD 0.139,
  provider success 0.95, shipment creation failure 0.001, return shipments 1 %) come from round 2's
  seed (`domain/msa/KOTLIN-MODEL.md`) and the simulation's defaults; they are
  workload parameters, not code facts.
- **Not decidable from code:** instance counts per class (cardinalities), the share of orders with
  coupons or several items, how often a client selects `totalCount`: these belong to the workload
  (`workload/WORKLOAD.md`) and the timing campaign.

## 10. Known limits of the extraction

- The call-graph cross-check is regex-based: it misses calls through `@Autowired` resolver
  parameters, expression-bodied handlers (`= NestRest.handle { ... }`), detached lambdas and
  overridden filters, and over-reaches from `when`-branch anchors; the curators covered these by
  hand (`notReached` with reasons, explicit accesses). The inventory misses
  `R2dbcEntityTemplate.insert` (shipment's Shipment insert has no `via`) and thin store wrappers.
- Dynamic table names (`$source`, `$table`) are resolved from the curated accesses.
- Request plans cover the round-2 request documents only; other clients' queries (frontend) are not
  in the data.
"""

# Domain extraction from misarch-kotlin `main`: report

The case's domain model (A; docs/model.md §3). Source: misarch-kotlin `main`, commit `d569ad9c0b726a5a46d7dfbde96381489ade4df5`, read through
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

| what | count |
|---|---|
| tables (Flyway migrations, 15 databases) | 71 |
| domain classes (incl. Media in S3) | 31 |
| join tables (references) | 9 |
| local copies (copy tables: mechanism instances) | 33 |
| references (id columns, id arrays, join tables) | 58 |
|   of which cross-service today | 39 |
| operations | 254 |
|   domain operations | 220 |
|   copy-maintenance operations | 34 |
|   trivial (no access, call or publish) | 20 |
| accesses (all operations) | 622 |
|   accesses of domain operations | 579 |
| synchronous calls today (Dapr invocation, HTTP) | 8 |
| gateway joins (entity fields contributed by another subgraph) | 20 |
| topics | 34 |
| publish sites / subscriptions | 45 / 51 |
| cross-class SQL statements (joins) / triggers | 9 / 3 |
| transactions / of them over several written classes | 64 / 13 |
| features with operations | 28 |

| operations by kind | n |
|---|---|
| command | 45 |
| query | 154 |
| reaction | 55 |

| operations by trigger | n |
|---|---|
| graphql | 199 |
| http | 2 |
| schedule | 2 |
| topic | 51 |

| accesses by realisation today | n |
|---|---|
| call | 8 |
| copy | 142 |
| local | 448 |
| payload | 24 |

| accesses by shape | n |
|---|---|
| batch | 119 |
| list | 118 |
| one | 290 |
| optional | 30 |
| perItem | 65 |

Per service (today's owner):

| service | classes | copies | query | command | reaction | copy ops | trivial | accesses |
|---|---|---|---|---|---|---|---|---|
| address | 2 | 1 | 6 | 3 | 0 | 1 | 1 | 13 |
| catalog | 6 | 2 | 28 | 8 | 0 | 2 | 0 | 126 |
| discount | 4 | 5 | 21 | 5 | 1 | 4 | 4 | 111 |
| inventory | 1 | 1 | 5 | 4 | 6 | 1 | 2 | 33 |
| invoice | 1 | 3 | 3 | 0 | 1 | 4 | 1 | 14 |
| media | 1 | 0 | 2 | 1 | 0 | 0 | 1 | 4 |
| notification | 1 | 1 | 4 | 2 | 1 | 1 | 1 | 12 |
| order | 3 | 6 | 7 | 2 | 1 | 8 | 1 | 56 |
| payment | 2 | 1 | 7 | 3 | 5 | 0 | 2 | 52 |
| return | 1 | 4 | 7 | 1 | 0 | 4 | 3 | 32 |
| review | 1 | 3 | 10 | 3 | 0 | 3 | 0 | 29 |
| shipment | 2 | 3 | 13 | 2 | 3 | 3 | 3 | 56 |
| shoppingcart | 2 | 1 | 4 | 4 | 2 | 1 | 1 | 29 |
| tax | 2 | 0 | 8 | 3 | 0 | 0 | 0 | 21 |
| user | 1 | 0 | 4 | 1 | 1 | 0 | 0 | 9 |
| wishlist | 1 | 2 | 5 | 3 | 0 | 2 | 0 | 25 |

## 3. Classes, copies, references

| class | owner today | table | row bytes | ops reading | ops writing | copied by |
|---|---|---|---|---|---|---|
| Category | catalog | CategoryEntity | 104 | 14 | 1 | discount |
| CategoryCharacteristic | catalog | CategoryCharacteristicEntity | 184 | 9 | 3 |  |
| CategoryCharacteristicValue | catalog | CategoryCharacteristicValueEntity | 144 | 2 | 3 |  |
| Coupon | discount | CouponEntity | 112 | 10 | 3 | order |
| CouponRedemption | discount | CouponRedemptionEntity | 56 | 6 | 1 |  |
| Discount | discount | DiscountEntity | 72 | 16 | 2 |  |
| DiscountUsage | discount | DiscountUsageEntity | 80 | 6 | 1 |  |
| Invoice | invoice | InvoiceEntity | 160 | 4 | 1 |  |
| Media | media | s3 |  | 6 | 1 | catalog |
| Notification | notification | NotificationEntity | 136 | 4 | 3 |  |
| Order | order | OrderEntity | 224 | 22 | 3 | payment, return |
| OrderCompensation | order | OrderCompensationEntity | 72 | 1 | 1 |  |
| OrderItem | order | OrderItemEntity | 205 | 21 | 4 | payment, return, shipment |
| Payment | payment | PaymentEntity | 124 | 7 | 5 |  |
| PaymentInformation | payment | PaymentInformationEntity | 216 | 12 | 3 |  |
| Product | catalog | ProductEntity | 89 | 16 | 2 | discount, review |
| ProductItem | inventory | ProductItemEntity | 112 | 9 | 10 |  |
| ProductVariant | catalog | ProductVariantEntity | 73 | 24 | 4 | discount, inventory, order, review, shoppingcart, wishlist |
| ProductVariantVersion | catalog | ProductVariantVersionEntity | 164 | 13 | 3 | order, return, shipment |
| Return | return | ReturnEntity | 104 | 6 | 1 |  |
| Review | review | ReviewEntity | 171 | 10 | 3 |  |
| Shipment | shipment | ShipmentEntity | 136 | 12 | 3 | return |
| ShipmentMethod | shipment | ShipmentMethodEntity | 156 | 9 | 2 | order |
| ShoppingCart | shoppingcart | UserEntity | 48 | 3 | 6 |  |
| ShoppingCartItem | shoppingcart | ShoppingCartItemEntity | 88 | 7 | 5 |  |
| TaxRate | tax | TaxRateEntity | 120 | 11 | 3 | catalog, order |
| TaxRateVersion | tax | TaxRateVersionEntity | 76 | 7 | 2 | order |
| User | user | UserEntity | 184 | 21 | 2 | address, discount, invoice, notification, order, review, wishlist |
| UserAddress | address | AddressEntity | 328 | 8 | 2 | invoice, order, shipment |
| VendorAddress | address | AddressEntity | 328 | 4 | 1 | invoice, shipment |
| Wishlist | wishlist | WishlistEntity | 104 | 6 | 3 |  |

Local copies (each one an instance of the "local copy fed by events" mechanism, not a class):

| copy | of (attributes) | fed by | writer ops | reader ops |  |
|---|---|---|---|---|---|
| address.UserEntity | User(id) | user/user/created | 1 | 2 |  |
| catalog.TaxRateEntity | TaxRate(id) | tax/tax-rate/created | 1 | 4 |  |
| catalog.MediaEntity | Media(id) | media/media/created | 1 | 4 |  |
| discount.UserEntity | User(id) | user/user/created | 1 | 2 |  |
| discount.ProductEntity | Product(id) | catalog/product/created | 1 | 3 |  |
| discount.ProductVariantEntity | ProductVariant(id, productId) | catalog/product-variant/created | 1 | 5 |  |
| discount.CategoryEntity | Category(id) | catalog/category/created | 1 | 3 |  |
| discount.ProductToCategoryEntity | Product(categories) | catalog/product/created | 1 | 2 |  |
| inventory.ProductVariantEntity | ProductVariant(id) | catalog/product-variant/created | 1 | 2 |  |
| invoice.UserEntity | User(id, firstName, lastName) | user/user/created | 1 | 1 |  |
| invoice.UserAddressEntity | UserAddress(id, userId, street1, street2, city, postalCode, country, companyName, firstName, lastName) | address/user-address/created, address/user-address/archived | 2 | 1 |  |
| invoice.VendorAddressEntity | VendorAddress(id, street1, street2, city, postalCode, country, companyName, version) | address/vendor-address/created | 1 | 1 |  |
| notification.UserEntity | User(id) | user/user/created | 1 | 3 |  |
| order.UserEntity | User(id) | user/user/created, address/user-address/created | 2 | 1 |  |
| order.UserAddressEntity | UserAddress(id, userId, archivedAt) | address/user-address/created, address/user-address/archived | 2 | 1 |  |
| order.CouponEntity | Coupon(id) | discount/coupon/created | 1 | 1 |  |
| order.ShipmentMethodEntity | ShipmentMethod(id) | shipment/shipment-method/created | 1 | 1 |  |
| order.ProductVariantEntity | ProductVariant(id, isPubliclyVisible, currentVersion), ProductVariantVersion(id, retailPrice, taxRateId) | catalog/product-variant-version/created, catalog/product-variant/updated | 2 | 1 |  |
| order.TaxRateEntity | TaxRate(id, currentVersionId), TaxRateVersion(id, rate, version) | tax/tax-rate-version/created | 1 | 1 |  |
| payment.OpenOrderEntity | Order(id, userId, createdAt, orderStatus, placedAt, rejectionReason, shipmentAddressId, invoiceAddressId, compensatableOrderAmount, paymentInformationId, paymentAuthorization, vatNumber), OrderItem(id, createdAt, productVariantVersionId, productVariantId, taxRateVersionId, shoppingCartItemId, count, compensatableAmount, shipmentMethodId, discountIds) | discount/order/validation-succeeded | 1 | 3 | payload |
| return.OrderEntity | Order(id, userId) | order/order/created | 1 | 4 | payload |
| return.OrderItemEntity | OrderItem(id, orderId, compensatableAmount, productVariantVersionId), Shipment(orderItems) | order/order/created, shipment/shipment/created | 3 | 3 | payload |
| return.ProductVariantVersionEntity | ProductVariantVersion(id, canBeReturnedForDays) | catalog/product-variant-version/created | 1 | 1 |  |
| return.ShipmentEntity | Shipment(id, status) | shipment/shipment/created, shipment/shipment/status-updated | 2 | 1 |  |
| review.UserEntity | User(id) | user/user/created | 1 | 2 |  |
| review.ProductEntity | Product(id) | catalog/product/created | 1 | 1 |  |
| review.ProductVariantEntity | ProductVariant(id, productId) | catalog/product-variant/created | 1 | 2 |  |
| shipment.AddressEntity | UserAddress(id, userId, street1, street2, city, postalCode, country, companyName), VendorAddress(id, street1, street2, city, postalCode, country, companyName) | address/user-address/created, address/vendor-address/created | 2 | 3 |  |
| shipment.ProductVariantVersionEntity | ProductVariantVersion(id, weight) | catalog/product-variant-version/created | 1 | 4 |  |
| shipment.OrderItemEntity | OrderItem(id, count, productVariantVersionId) | payment/payment/payment-enabled | 1 | 3 | payload |
| shoppingcart.ProductVariantEntity | ProductVariant(id) | catalog/product-variant/created | 1 | 2 |  |
| wishlist.UserEntity | User(id) | user/user/created | 1 | 2 |  |
| wishlist.ProductVariantEntity | ProductVariant(id) | catalog/product-variant/created | 1 | 3 |  |

## 4. Statements and transactions over several classes

Cross-class statements (one SQL statement or trigger over several tables). Only the owner's own
class tables in a statement bind classes; a statement that reads a local copy is the copy
mechanism at work, and a join table alone binds nothing (it is a reference).

| statement | classes | table kinds | used by | evidence |
|---|---|---|---|---|
| catalog.CategoryCharacteristicValueRepository.findValidCategoryCharacteristics | Category, CategoryCharacteristic, Product, ProductVariant, ProductVariantVersion | class, join | catalog.createProduct, catalog.createProductVariant, catalog.createProductVariantVersion | catalog `persistence/repository/CategoryCharacteristicValueRepository.kt:66` |
| catalog.trigger.trg_check_category_value_product_category | Category, CategoryCharacteristic, CategoryCharacteristicValue, Product, ProductVariant, ProductVariantVersion | class, join | catalog.createProduct, catalog.createProductVariant, catalog.createProductVariantVersion | catalog `db/migration/V1_1__create_relations.sql:100` |
| discount.DiscountService.generateDiscountAppliesToCategoryCondition | Category, Discount, Product, ProductVariant | copy, join | discount.ProductVariant.applicableDiscounts, discount.findApplicableDiscounts | discount `service/DiscountService.kt:474` |
| discount.DiscountService.generateDiscountAppliesToProductCondition | Discount, Product, ProductVariant | copy, join | discount.ProductVariant.applicableDiscounts, discount.findApplicableDiscounts | discount `service/DiscountService.kt:460` |
| discount.DiscountService.generateFullDiscountAppliesCondition | Coupon, CouponRedemption | class | discount.ProductVariant.applicableDiscounts | discount `service/DiscountService.kt:394` |
| discount.DiscountService.generateUserHasCouponCondition | Coupon, CouponRedemption | class | discount.findApplicableDiscounts | discount `service/DiscountService.kt:372` |
| discount.trigger.before_insert_update_coupon_usages | Coupon, CouponRedemption | class | discount.registerCoupon | discount `db/migration/V1_1__create_relations.sql:117` |
| discount.trigger.check_discount_usages_trigger | Discount, DiscountUsage | class | discount.on:inventory/product-item/reservation-succeeded | discount `db/migration/V1_1__create_relations.sql:143` |
| order.OrderCompensationToOrderItemRepository.findByOrderId | OrderCompensation, OrderItem | class, join | order.on:shipment/shipment/creation-failed | order `persistence/repository/OrderCompensationToOrderItemRepository.kt:26` |
| payment.PaymentRepository.findAllForUpdateByStatusAndPaymentMethodCreatedBefore | Payment, PaymentInformation | class | payment.job:checkOpenInvoicePayments, payment.job:checkOpenPrepaymentPayments | payment `persistence/repository/PaymentRepository.kt:39` |
| return.ReturnConnection.nodes | Order, Return | class, copy | return.User.returns, return.returns | return `graphql/model/connection/ReturnConnection.kt:26` |
| return.ReturnConnection.totalCount | Order, Return | class, copy | return.User.returns, return.returns | return `graphql/model/connection/ReturnConnection.kt:26` |

Transactions that write several domain classes:

| operation | classes written together | also in the transaction | publish inside | evidence |
|---|---|---|---|---|
| catalog.createCategory | Category, CategoryCharacteristic |  | yes | catalog `service/CategoryService.kt:28` |
| catalog.createProduct | CategoryCharacteristicValue, Product, ProductVariant, ProductVariantVersion | Category, CategoryCharacteristic, Media, TaxRate | yes | catalog `service/ProductService.kt:41` |
| catalog.createProductVariant | CategoryCharacteristicValue, ProductVariant, ProductVariantVersion | Category, CategoryCharacteristic, Media, Product, TaxRate | yes | catalog `service/ProductVariantService.kt:37` |
| catalog.createProductVariantVersion | CategoryCharacteristicValue, ProductVariant, ProductVariantVersion | Category, CategoryCharacteristic, Media, Product, TaxRate | yes | catalog `service/ProductVariantVersionService.kt:46` |
| discount.registerCoupon | Coupon, CouponRedemption |  |  | discount `service/CouponService.kt:90` |
| order.createOrder | Order, OrderItem |  |  | order `service/OrderService.kt:48` |
| shoppingcart.updateShoppingcart | ShoppingCart, ShoppingCartItem | ProductVariant |  | shoppingcart `service/ShoppingCartService.kt:35` |
| shoppingcart.createShoppingcartItem | ShoppingCart, ShoppingCartItem | ProductVariant |  | shoppingcart `service/ShoppingCartItemService.kt:34` |
| shoppingcart.updateShoppingcartItem | ShoppingCart, ShoppingCartItem |  |  | shoppingcart `service/ShoppingCartItemService.kt:66` |
| shoppingcart.deleteShoppingcartItem | ShoppingCart, ShoppingCartItem |  |  | shoppingcart `service/ShoppingCartItemService.kt:83` |
| shoppingcart.on:order/order/created | ShoppingCart, ShoppingCartItem |  |  | shoppingcart `service/ShoppingCartService.kt:65` |
| tax.createTaxRate | TaxRate, TaxRateVersion |  | yes | tax `service/TaxRateService.kt:32` |
| tax.createTaxRateVersion | TaxRate, TaxRateVersion |  | yes | tax `service/TaxRateVersionService.kt:36` |

## 5. Events

| topic | role | published by | subscribers (* = copy maintenance) |
|---|---|---|---|
| address/user-address/archived | replication | address.archiveUserAddress | invoice*, order* |
| address/user-address/created | replication | address.createUserAddress | invoice*, order*, shipment* |
| address/vendor-address/created | replication | address.createVendorAddress | invoice*, shipment* |
| catalog/category/created | replication | catalog.createCategory | discount* |
| catalog/product-variant-version/created | replication | catalog.createProduct, catalog.createProductVariant, catalog.createProductVariantVersion | order*, return*, shipment* |
| catalog/product-variant/created | replication | catalog.createProduct, catalog.createProductVariant | discount*, inventory*, review*, shoppingcart*, wishlist* |
| catalog/product-variant/updated | replication | catalog.updateProductVariant | order* |
| catalog/product/created | replication | catalog.createProduct | discount*, review* |
| catalog/product/updated | unsubscribed | catalog.updateProduct |  |
| discount/coupon/created | replication | discount.createCoupon | order* |
| discount/coupon/updated | unsubscribed | discount.updateCoupon |  |
| discount/discount/created | unsubscribed | discount.createDiscount |  |
| discount/discount/updated | unsubscribed | discount.updateDiscount |  |
| discount/order/validation-failed | process | discount.on:inventory/product-item/reservation-succeeded | inventory |
| discount/order/validation-succeeded | process | discount.on:inventory/product-item/reservation-succeeded | invoice, payment |
| inventory/product-item/reservation-failed | unsubscribed | inventory.on:order/order/created |  |
| inventory/product-item/reservation-succeeded | process | inventory.on:order/order/created | discount |
| invoice/invoice/created | unsubscribed | invoice.on:discount/order/validation-succeeded |  |
| media/media/created | replication | media.uploadMedia | catalog* |
| notification/notification/create | process | (none) | notification |
| order/order-compensation/created | unsubscribed | order.on:shipment/shipment/creation-failed |  |
| order/order/created | mixed | order.placeOrder | inventory, return*, shoppingcart |
| payment/payment/payment-enabled | process | payment.on:discount/order/validation-succeeded, payment.http:/payment/update-payment-status | inventory, shipment |
| payment/payment/payment-failed | process | payment.on:discount/order/validation-succeeded, payment.http:/payment/update-payment-status, payment.job:checkOpenInvoicePayments, payment.job:checkOpenPrepaymentPayments | inventory |
| return/return/created | process | return.createReturn | shipment |
| shipment/shipment-method/archived | unsubscribed | shipment.archiveShipmentMethod |  |
| shipment/shipment-method/created | replication | shipment.createShipmentMethod | order* |
| shipment/shipment/created | mixed | shipment.on:payment/payment/payment-enabled, shipment.on:return/return/created | inventory, return* |
| shipment/shipment/creation-failed | process | shipment.on:payment/payment/payment-enabled, shipment.on:return/return/created | order |
| shipment/shipment/status-updated | mixed | shipment.http:/shipment/{id}/status | inventory, return* |
| tax/tax-rate-version/created | replication | tax.createTaxRate, tax.createTaxRateVersion | order* |
| tax/tax-rate/created | replication | tax.createTaxRate | catalog* |
| user/user/create | process | Keycloak (registration), outside misarch-kotlin | user |
| user/user/created | mixed | user.on:user/user/create | address*, discount*, invoice*, notification*, order*, payment, review*, shoppingcart, wishlist* |

## 6. Coupling structure

Bindings: pairs of classes that a transaction, a cross-class statement or a composition ties
together today.

| class A | class B | ops touching both | rate (msa req/s) | ops writing both | transactions | statements | composition |
|---|---|---|---|---|---|---|---|
| Category | CategoryCharacteristic | 6 | 0.0041 | 1 | 1 | 1 | yes |
| Category | Product | 6 | 1.4124 | 0 | 0 | 1 |  |
| Category | ProductVariant | 5 | 0.005 | 0 | 0 | 1 |  |
| Category | ProductVariantVersion | 3 | 0.004 | 0 | 0 | 1 |  |
| CategoryCharacteristic | CategoryCharacteristicValue | 3 | 0.004 | 0 | 0 | 1 |  |
| CategoryCharacteristic | Product | 3 | 0.004 | 0 | 0 | 1 |  |
| CategoryCharacteristic | ProductVariant | 3 | 0.004 | 0 | 0 | 2 |  |
| CategoryCharacteristic | ProductVariantVersion | 3 | 0.004 | 0 | 0 | 2 |  |
| CategoryCharacteristicValue | Product | 3 | 0.004 | 1 | 1 | 0 |  |
| CategoryCharacteristicValue | ProductVariant | 3 | 0.004 | 3 | 3 | 1 |  |
| CategoryCharacteristicValue | ProductVariantVersion | 3 | 0.004 | 3 | 3 | 1 | yes |
| Coupon | CouponRedemption | 6 | 0.4932 | 1 | 1 | 3 | yes |
| Coupon | Discount | 4 | 0.4842 | 0 | 0 | 0 | yes |
| Discount | DiscountUsage | 3 | 0.9663 | 0 | 0 | 1 | yes |
| Order | OrderItem | 14 | 3.6696 | 2 | 1 | 0 | yes |
| Payment | PaymentInformation | 6 | 0.4832 | 0 | 0 | 1 |  |
| Product | ProductVariant | 8 | 0.007 | 1 | 1 | 1 | yes |
| Product | ProductVariantVersion | 3 | 0.004 | 1 | 1 | 1 |  |
| ProductVariant | ProductVariantVersion | 4 | 0.4872 | 3 | 3 | 2 | yes |
| ShoppingCart | ShoppingCartItem | 5 | 1.8906 | 5 | 5 | 0 | yes |
| TaxRate | TaxRateVersion | 3 | 0.4834 | 2 | 2 | 0 | yes |

Most co-accessed pairs (domain operations touching both classes; rate: msa request rate at
loadFactor 1 of the mapped operations):

| class A | class B | ops touching both | rate (msa req/s) | bindings |
|---|---|---|---|---|
| Order | OrderItem | 14 | 3.6696 | transaction, composition |
| Order | ProductItem | 5 | 2.2148 |  |
| ShoppingCart | ShoppingCartItem | 5 | 1.8906 | transaction, composition |
| ProductVariant | ShoppingCartItem | 3 | 1.8906 |  |
| Category | Product | 6 | 1.4124 | join |
| ProductVariant | ShoppingCart | 2 | 1.4074 |  |
| Order | UserAddress | 3 | 1.2485 |  |
| OrderItem | UserAddress | 3 | 1.2485 |  |
| User | UserAddress | 3 | 0.9763 |  |
| Discount | DiscountUsage | 3 | 0.9663 | join, composition |
| Discount | Order | 2 | 0.9663 |  |
| Discount | OrderItem | 2 | 0.9663 |  |
| DiscountUsage | Order | 2 | 0.9663 |  |
| DiscountUsage | OrderItem | 2 | 0.9663 |  |
| Order | ShoppingCartItem | 2 | 0.9663 |  |
| Order | User | 2 | 0.9663 |  |
| OrderItem | ProductItem | 2 | 0.9663 |  |
| OrderItem | ShoppingCartItem | 2 | 0.9663 |  |
| OrderItem | User | 2 | 0.9663 |  |
| OrderItem | ProductVariantVersion | 4 | 0.7753 |  |
| ProductVariantVersion | ShipmentMethod | 4 | 0.7703 |  |
| Order | ProductVariantVersion | 3 | 0.7703 |  |
| OrderItem | ShipmentMethod | 3 | 0.7703 |  |
| Order | ShipmentMethod | 2 | 0.7653 |  |
| ProductVariantVersion | UserAddress | 2 | 0.7653 |  |

Inseparable candidates and the size of the cut space:

- **atoms (all bindings)** (classes connected by a multi-class transaction, a cross-class statement (join, trigger) or a composition): 19 groups, Bell number 5.83e+12 partitions; groups of more than one class: {Category, CategoryCharacteristic, CategoryCharacteristicValue, Product, ProductVariant, ProductVariantVersion}; {Coupon, CouponRedemption, Discount, DiscountUsage}; {Order, OrderItem}; {Payment, PaymentInformation}; {ShoppingCart, ShoppingCartItem}; {TaxRate, TaxRateVersion}
- **atoms (transactions and statements only)** (classes connected by a multi-class transaction or a cross-class statement only): 20 groups, Bell number 5.17e+13 partitions; groups of more than one class: {Category, CategoryCharacteristic, CategoryCharacteristicValue, Product, ProductVariant, ProductVariantVersion}; {Coupon, CouponRedemption}; {Discount, DiscountUsage}; {Order, OrderItem}; {Payment, PaymentInformation}; {ShoppingCart, ShoppingCartItem}; {TaxRate, TaxRateVersion}
- **atoms (hot paths only)** (classes connected by a multi-class transaction or a cross-class statement of an operation with msa rate >= 0.01 req/s (loadFactor 1)): 27 groups, Bell number 5.46e+20 partitions; groups of more than one class: {Coupon, CouponRedemption}; {Discount, DiscountUsage}; {Order, OrderItem}; {ShoppingCart, ShoppingCartItem}
- all 31 classes free: Bell number 1.03e+25

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

- msa operations: 70, mapped 70
- msa entities: 31, mapped 31
- msa data needs: 65: absent 3, gap 2, mapped 60

| msa need | kind | msa mechanism | our access / event / join (first 2) | status |
|---|---|---|---|---|
| createUser->PaymentInformation | COMMAND | async | user.on:user/user/create -> user/user/created -> payment.on:user/user/created | mapped |
| createUserAddress->User | REPLICATION | replica | address.createUserAddress [User read copy] | mapped |
| registerCoupon->User | REPLICATION | replica |  | gap |
| createNotification->User | REPLICATION | replica | notification.on:notification/notification/create [User read copy] | mapped |
| createPaymentInformation->User | REPLICATION | replica | payment keeps no user copy; createCreditCardPaymentInformation checks no user (curated/payment.yaml) | absent |
| createReview->User | REPLICATION | replica | review.createReview [User read copy] | mapped |
| createShoppingcartItem->User | REPLICATION | replica |  | gap |
| createWishlist->User | REPLICATION | replica | wishlist.createWishlist [User read copy] | mapped |
| createProduct->TaxRate | REPLICATION | replica | catalog.createProduct [TaxRate read copy] | mapped |
| createProduct->Media | REPLICATION | replica | catalog.createProduct [Media read copy] | mapped |
| createProductItemBatch->ProductVariant | REPLICATION | replica | inventory.createProductItemBatch [ProductVariant read copy] | mapped |
| createShoppingcartItem->ProductVariant | REPLICATION | replica | shoppingcart.createShoppingcartItem [ProductVariant read copy] | mapped |
| updateWishlist->ProductVariant | REPLICATION | replica | wishlist.updateWishlist [ProductVariant read copy] | mapped |
| findApplicableDiscounts->ProductVariant | REPLICATION | replica | discount.findApplicableDiscounts [ProductVariant read copy]; discount.findApplicableDiscounts [ProductVariant read copy] | mapped |
| findApplicableDiscounts->Product | REPLICATION | replica | discount.findApplicableDiscounts [Product read copy] | mapped |
| findApplicableDiscounts->Category | REPLICATION | replica | discount.findApplicableDiscounts [Product read copy] | mapped |
| calculateShipmentFees->ProductVariantVersion | REPLICATION | replica | shipment.calculateShipmentFees [ProductVariantVersion read copy] | mapped |
| createReview->Product | REPLICATION | replica | createReview reads the ProductVariant copy (with productId) only; review's Product copy serves _entities(Product) | absent |
| createReview->ProductVariant | REPLICATION | replica | review.createReview [ProductVariant read copy] | mapped |
| createInvoice->User | REPLICATION | replica | invoice.on:discount/order/validation-succeeded [User read copy] | mapped |
| createInvoice->UserAddress | REPLICATION | replica | invoice.on:discount/order/validation-succeeded [UserAddress read copy] | mapped |
| createInvoice->VendorAddress | REPLICATION | replica | invoice.on:discount/order/validation-succeeded [VendorAddress read copy] | mapped |
| createShipments->UserAddress | REPLICATION | replica | shipment.on:payment/payment/payment-enabled [UserAddress read copy]; shipment.on:payment/payment/payment-enabled [UserAddress read copy] | mapped |
| createShipments->VendorAddress | REPLICATION | replica | order shipments read only the UserAddress copy; the VendorAddress copy is read by createReturnShipment | absent |
| createOrder->User | REPLICATION | replica | order.createOrder [User read copy] | mapped |
| createOrder->ShipmentMethod | REPLICATION | replica | order.createOrder [ShipmentMethod read copy]; order.createOrder [ShipmentMethod read call] | mapped |
| createOrder->Coupon | REPLICATION | replica | order.createOrder [Coupon read copy]; order.createOrder [Coupon read call] | mapped |
| createOrder->UserAddress | REPLICATION | replica | order.createOrder [UserAddress read copy] | mapped |
| createOrder->ShoppingCartItem | QUERY | sync | order.createOrder [ShoppingCartItem read call] | mapped |
| createOrder->ProductVariant | REPLICATION | replica | order.createOrder [ProductVariant read copy] | mapped |
| createOrder->ProductVariantVersion | REPLICATION | replica | order.createOrder [ProductVariantVersion read copy]; order.createOrder [ProductVariantVersion read call] | mapped |
| createOrder->ProductItem | QUERY | sync | order.createOrder [ProductItem read call] | mapped |
| createOrder->TaxRateVersion | REPLICATION | replica | order.createOrder [TaxRateVersion read copy] | mapped |
| createOrder->Discount | QUERY | sync | order.createOrder [Discount read call] | mapped |
| createOrder->ShipmentMethod | QUERY | sync | order.createOrder [ShipmentMethod read copy]; order.createOrder [ShipmentMethod read call] | mapped |
| createReturn->Order | REPLICATION | replica | return.createReturn [Order read copy] | mapped |
| createReturn->Shipment | REPLICATION | replica | return.createReturn [Shipment read copy]; return.createReturn [Shipment read copy] | mapped |
| createReturn->ProductVariantVersion | REPLICATION | replica | return.createReturn [ProductVariantVersion read copy] | mapped |
| startPayment->Order | REPLICATION | replica | payment.on:discount/order/validation-succeeded [Order read payload]; payment.on:discount/order/validation-succeeded [Order write copy] | mapped |
| createInvoice->Order | REPLICATION | replica | invoice.on:discount/order/validation-succeeded [Order read payload] | mapped |
| createShipments->Order | REPLICATION | replica | shipment.on:payment/payment/payment-enabled [Order read payload] | mapped |
| product->Review | QUERY | join | catalog.product,catalog.Product.categories,catalog.Product.defaultVariant,catalog.Product.variants -> gateway -> review._entities.ProductVariant, review.ProductVariant.averageRating | mapped |
| currentUserAddresses->UserAddress | QUERY | join | user.currentUser -> gateway -> address._entities.User, address.User.addresses | mapped |
| currentUserPaymentInfos->PaymentInformation | QUERY | join | user.currentUser -> gateway -> payment._entities.User, payment.User.paymentInformations | mapped |
| currentUserNotifications->Notification | QUERY | join | user.currentUser -> gateway -> notification._entities.User, notification.User.notifications | mapped |
| myOrders->Shipment | QUERY | join | order.order,order.Order.orderItems -> gateway -> shipment._entities.Order, shipment.Order.shipments | mapped |
| viewWishlist->ProductVariant | QUERY | join | wishlist.Wishlist.productVariants [ProductVariant read copy]; wishlist.Wishlist.productVariants [ProductVariant read copy] | mapped |
| placeOrder->ProductItem | COMMAND | async | order.placeOrder -> order/order/created -> inventory.on:order/order/created | mapped |
| placeOrder->ShoppingCartItem | COMMAND | async | order.placeOrder -> order/order/created -> shoppingcart.on:order/order/created | mapped |
| reserveItems->DiscountUsage | COMMAND | async | inventory.on:order/order/created -> inventory/product-item/reservation-succeeded -> discount.on:inventory/product-item/reservation-succeeded | mapped |
| validateOrder->Payment | COMMAND | async | discount.on:inventory/product-item/reservation-succeeded -> discount/order/validation-succeeded -> payment.on:discount/order/validation-succeeded | mapped |
| validateOrder->Invoice | COMMAND | async | discount.on:inventory/product-item/reservation-succeeded -> discount/order/validation-succeeded -> invoice.on:discount/order/validation-succeeded | mapped |
| validateOrder->ProductItem | COMMAND | async | discount.on:inventory/product-item/reservation-succeeded -> discount/order/validation-failed -> inventory.on:discount/order/validation-failed; discount.on:inventory/product-item/reservation-succeeded -> discount/order/validation-failed -> inventory.on:discount/order/validation-failed | mapped |
| startPayment->Shipment | COMMAND | async | payment.on:discount/order/validation-succeeded -> payment/payment/payment-enabled -> shipment.on:payment/payment/payment-enabled | mapped |
| startPayment->ProductItem | COMMAND | async | payment.on:discount/order/validation-succeeded -> payment/payment/payment-enabled -> inventory.on:payment/payment/payment-enabled; payment.on:discount/order/validation-succeeded -> payment/payment/payment-failed -> inventory.on:payment/payment/payment-failed | mapped |
| startPayment->Payment | COMMAND | async | payment.on:discount/order/validation-succeeded [Payment write local local]; payment.on:discount/order/validation-succeeded [Payment write local local] | mapped |
| updatePaymentStatus->ProductItem | COMMAND | async | payment.http:/payment/update-payment-status -> payment/payment/payment-enabled -> inventory.on:payment/payment/payment-enabled; payment.http:/payment/update-payment-status -> payment/payment/payment-failed -> inventory.on:payment/payment/payment-failed | mapped |
| updatePaymentStatus->Shipment | COMMAND | async | payment.http:/payment/update-payment-status -> payment/payment/payment-enabled -> shipment.on:payment/payment/payment-enabled | mapped |
| updatePaymentStatus->ProductItem (setInFulfillment) | COMMAND | async | payment.http:/payment/update-payment-status -> payment/payment/payment-enabled -> inventory.on:payment/payment/payment-enabled; payment.http:/payment/update-payment-status -> payment/payment/payment-failed -> inventory.on:payment/payment/payment-failed | mapped |
| createShipments->ProductItem | COMMAND | async | shipment.on:payment/payment/payment-enabled -> shipment/shipment/created -> inventory.on:shipment/shipment/created | mapped |
| createShipments->Shipment | COMMAND | async | shipment.on:payment/payment/payment-enabled -> shipment/shipment/created -> return.on:shipment/shipment/created | mapped |
| createShipments->OrderCompensation | COMMAND | async | shipment.on:payment/payment/payment-enabled -> shipment/shipment/creation-failed -> order.on:shipment/shipment/creation-failed | mapped |
| updateShipmentStatus->ProductItem | COMMAND | async | shipment.http:/shipment/{id}/status -> shipment/shipment/status-updated -> inventory.on:shipment/shipment/status-updated | mapped |
| createReturn->Shipment | COMMAND | async | return.createReturn [Shipment read copy]; return.createReturn [Shipment read copy] | mapped |
| createReturnShipment->Shipment | COMMAND | async | shipment.on:return/return/created -> shipment/shipment/created -> return.on:shipment/shipment/created | mapped |

## 8. What the timing campaign measures

Parts: per domain operation its own work, and per (operation, class, read/write) the access part
when it is local. The seed column splits round 2's calibrated demand of the mapped msa operation
(cpuMs over the mapped operations of its home service, dbMs over their accesses): a placeholder
for ranking, not a measurement.

| operation | kind | part | seed (msa, split) |
|---|---|---|---|
| address.address | query | own work | 0.30 ms CPU |
|  |  | UserAddress read (1 stmt) | 0.05 ms DB |
| address.vendorAddress | query | own work | ? |
|  |  | VendorAddress read (1 stmt) | ? |
| address.createUserAddress | command | own work | 2.68 ms CPU |
|  |  | User read (1 stmt) | 0.29 ms DB |
|  |  | UserAddress write (1 stmt) | 0.29 ms DB |
| address.createVendorAddress | command | own work | 2.68 ms CPU |
|  |  | VendorAddress write (1 stmt) | 0.57 ms DB |
| address.archiveUserAddress | command | own work | ? |
|  |  | UserAddress read (1 stmt) | ? |
|  |  | UserAddress write (1 stmt) | ? |
| address.User.addresses | query | own work | 1.11 ms CPU |
|  |  | UserAddress read (1, 1 if totalCount selected stmt) | 0.21 ms DB |
| address._entities.UserAddress | query | own work | 0.30 ms CPU |
|  |  | UserAddress read (1 stmt) | 0.05 ms DB |
| address._entities.VendorAddress | query | own work | 0.30 ms CPU |
|  |  | VendorAddress read (1 stmt) | 0.05 ms DB |
| address.UserAddress.user | query | own work | ? |
|  |  | User read (1 stmt) | ? |
| catalog.categories | query | own work | ? |
|  |  | Category read (1, 1 if totalCount selected stmt) | ? |
| catalog.category | query | own work | ? |
|  |  | Category read (1 stmt) | ? |
| catalog.categoryCharacteristic | query | own work | ? |
|  |  | CategoryCharacteristic read (1 stmt) | ? |
| catalog.product | query | own work | 0.60 ms CPU |
|  |  | Product read (1 stmt) | 0.06 ms DB |
| catalog.products | query | own work | 2.11 ms CPU |
|  |  | Product read (1, 1 if totalCount selected stmt) | 0.43 ms DB |
| catalog.createCategory | command | own work | 2.68 ms CPU |
|  |  | Category write (1 stmt) | 0.19 ms DB |
|  |  | CategoryCharacteristic write (|input.categoricalCharacteristics|, |input.numericalCharacteristics| stmt) | 0.38 ms DB |
| catalog.createCategoricalCategoryCharacteristic | command | own work | ? |
|  |  | Category read (1 stmt) | ? |
|  |  | CategoryCharacteristic write (1 stmt) | ? |
| catalog.createNumericalCategoryCharacteristic | command | own work | ? |
|  |  | Category read (1 stmt) | ? |
|  |  | CategoryCharacteristic write (1 stmt) | ? |
| catalog.createProduct | command | own work | 6.62 ms CPU |
|  |  | Category read (1 if categoryIds not empty, 1 if characteristic values given stmt) | 0.20 ms DB |
|  |  | CategoryCharacteristic read (1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.20 ms DB |
|  |  | CategoryCharacteristicValue write (|initialVersion.categoricalCharacteristicValues|, |initialVersion.numericalCharacteristicValues| stmt) | 0.20 ms DB |
|  |  | Media read (1 if mediaIds not empty stmt) | 0.10 ms DB |
|  |  | Product read (1 if characteristic values given, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.30 ms DB |
|  |  | Product write (1, |distinct input.categoryIds|, 1 stmt) | 0.30 ms DB |
|  |  | ProductVariant read (1, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.30 ms DB |
|  |  | ProductVariant write (1, 1 stmt) | 0.20 ms DB |
|  |  | ProductVariantVersion read (1, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.30 ms DB |
|  |  | ProductVariantVersion write (1, |distinct initialVersion.mediaIds| stmt) | 0.20 ms DB |
|  |  | TaxRate read (1 stmt) | 0.10 ms DB |
| catalog.createProductVariant | command | own work | 5.56 ms CPU |
|  |  | Category read (1 if characteristic values given stmt) | 0.08 ms DB |
|  |  | CategoryCharacteristic read (1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.16 ms DB |
|  |  | CategoryCharacteristicValue write (|initialVersion.categoricalCharacteristicValues|, |initialVersion.numericalCharacteristicValues| stmt) | 0.16 ms DB |
|  |  | Media read (1 if mediaIds not empty stmt) | 0.08 ms DB |
|  |  | Product read (1, 1 if characteristic values given, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.32 ms DB |
|  |  | ProductVariant read (1, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.24 ms DB |
|  |  | ProductVariant write (1, 1 stmt) | 0.16 ms DB |
|  |  | ProductVariantVersion read (1, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.24 ms DB |
|  |  | ProductVariantVersion write (1, |distinct initialVersion.mediaIds| stmt) | 0.16 ms DB |
|  |  | TaxRate read (1 stmt) | 0.08 ms DB |
| catalog.createProductVariantVersion | command | own work | 4.57 ms CPU |
|  |  | Category read (1 if characteristic values given stmt) | 0.07 ms DB |
|  |  | CategoryCharacteristic read (1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.15 ms DB |
|  |  | CategoryCharacteristicValue write (|input.categoricalCharacteristicValues|, |input.numericalCharacteristicValues| stmt) | 0.15 ms DB |
|  |  | Media read (1 if mediaIds not empty stmt) | 0.07 ms DB |
|  |  | Product read (1 if characteristic values given, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.22 ms DB |
|  |  | ProductVariant read (1, 1, 1 if characteristic values given, |upserted values (categorical + numerical)|, 1 stmt) | 0.37 ms DB |
|  |  | ProductVariant write (1 stmt) | 0.07 ms DB |
|  |  | ProductVariantVersion read (1, 1 if characteristic values given, |upserted values (categorical + numerical)| stmt) | 0.22 ms DB |
|  |  | ProductVariantVersion write (1, |distinct input.mediaIds| stmt) | 0.15 ms DB |
|  |  | TaxRate read (1 stmt) | 0.07 ms DB |
| catalog.updateProduct | command | own work | 3.25 ms CPU |
|  |  | Product read (1, 1 stmt) | 0.29 ms DB |
|  |  | Product write (1 stmt) | 0.14 ms DB |
|  |  | ProductVariant read (1 if input.defaultVariantId given stmt) | 0.14 ms DB |
| catalog.updateProductVariant | command | own work | 2.68 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.29 ms DB |
|  |  | ProductVariant write (1 stmt) | 0.29 ms DB |
| catalog._entities.CategoricalCategoryCharacteristic | query | own work | ? |
|  |  | CategoryCharacteristic read (1 stmt) | ? |
| catalog._entities.NumericalCategoryCharacteristic | query | own work | ? |
|  |  | CategoryCharacteristic read (1 stmt) | ? |
| catalog.CategoricalCategoryCharacteristic.category | query | own work | ? |
|  |  | Category read (1 stmt) | ? |
| catalog.NumericalCategoryCharacteristic.category | query | own work | ? |
|  |  | Category read (1 stmt) | ? |
| catalog.CategoricalCategoryCharacteristic.values | query | own work | ? |
|  |  | CategoryCharacteristicValue read (1, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| catalog.CategoricalCategoryCharacteristicValue.characteristic | query | own work | ? |
|  |  | CategoryCharacteristic read (1 stmt) | ? |
| catalog.NumericalCategoryCharacteristicValue.characteristic | query | own work | ? |
|  |  | CategoryCharacteristic read (1 stmt) | ? |
| catalog._entities.Category | query | own work | 0.22 ms CPU |
|  |  | Category read (1 stmt) | 0.04 ms DB |
| catalog.Category.characteristics | query | own work | ? |
|  |  | CategoryCharacteristic read (1, 1 if totalCount selected stmt) | ? |
| catalog.Category.products | query | own work | ? |
|  |  | Product read (1, 1, 1 if totalCount selected, 1 if totalCount selected stmt) | ? |
| catalog._entities.Product | query | own work | 0.22 ms CPU |
|  |  | Product read (1 stmt) | 0.04 ms DB |
| catalog.Product.categories | query | own work | 0.60 ms CPU |
|  |  | Category read (1, 1 if totalCount selected stmt) | 0.12 ms DB |
|  |  | Product read (1, 1 if totalCount selected stmt) | 0.12 ms DB |
| catalog.Product.defaultVariant | query | own work | 0.60 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.06 ms DB |
| catalog.Product.variants | query | own work | 0.60 ms CPU |
|  |  | ProductVariant read (1, 1 if totalCount selected stmt) | 0.12 ms DB |
| catalog._entities.ProductVariant | query | own work | 0.91 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.15 ms DB |
| catalog.ProductVariant.currentVersion | query | own work | 0.68 ms CPU |
|  |  | ProductVariantVersion read (1 stmt) | 0.12 ms DB |
| catalog.ProductVariant.product | query | own work | 0.68 ms CPU |
|  |  | Product read (1 stmt) | 0.12 ms DB |
| catalog.ProductVariant.versions | query | own work | ? |
|  |  | ProductVariantVersion read (1, 1 if totalCount selected stmt) | ? |
| catalog._entities.ProductVariantVersion | query | own work | 0.22 ms CPU |
|  |  | ProductVariantVersion read (1 stmt) | 0.04 ms DB |
| catalog.ProductVariantVersion.characteristicValues | query | own work | ? |
|  |  | CategoryCharacteristicValue read (1, 1 if totalCount selected stmt) | ? |
| catalog.ProductVariantVersion.medias | query | own work | ? |
|  |  | Media read (1, 1 if totalCount selected stmt) | ? |
|  |  | ProductVariantVersion read (1, 1 if totalCount selected stmt) | ? |
| catalog.ProductVariantVersion.productVariant | query | own work | ? |
|  |  | ProductVariant read (1 stmt) | ? |
| catalog.ProductVariantVersion.taxRate | query | own work | ? |
|  |  | TaxRate read (1 stmt) | ? |
| discount.coupon | query | own work | ? |
|  |  | Coupon read (1 stmt) | ? |
| discount.discount | query | own work | ? |
|  |  | Discount read (1 stmt) | ? |
| discount.findApplicableDiscounts | query | own work | 3.12 ms CPU |
|  |  | Coupon read (|product variants of the input|, 1 if coupon ids given stmt) | 0.04 ms DB |
|  |  | CouponRedemption read (|product variants of the input| stmt) | 0.02 ms DB |
|  |  | Discount read (|product variants of the input|, |product variants of the input|, |product variants of the input|, |product variants of the input| stmt) | 0.08 ms DB |
|  |  | DiscountUsage read (|product variants of the input|, 1 stmt) | 0.04 ms DB |
|  |  | Product read (|product variants of the input| stmt) | 0.02 ms DB |
|  |  | ProductVariant read (1, |product variants of the input| stmt) | 0.04 ms DB |
| discount.createCoupon | command | own work | 2.68 ms CPU |
|  |  | Coupon read (1 if condition stmt) | 0.19 ms DB |
|  |  | Coupon write (1 stmt) | 0.19 ms DB |
|  |  | Discount read (1 stmt) | 0.19 ms DB |
| discount.createDiscount | command | own work | 2.68 ms CPU |
|  |  | Category read (1 if discountAppliesToCategoryIds not empty stmt) | 0.08 ms DB |
|  |  | Discount write (1, |discountAppliesToCategoryIds|, |discountAppliesToProductIds|, |discountAppliesToProductVariantIds| stmt) | 0.33 ms DB |
|  |  | Product read (1 if discountAppliesToProductIds not empty stmt) | 0.08 ms DB |
|  |  | ProductVariant read (1 if discountAppliesToProductVariantIds not empty stmt) | 0.08 ms DB |
| discount.registerCoupon | command | own work | 2.68 ms CPU |
|  |  | Coupon read (1 if condition, 1 stmt) | 0.29 ms DB |
|  |  | Coupon write (1 stmt) | 0.14 ms DB |
|  |  | CouponRedemption write (1 stmt) | 0.14 ms DB |
| discount.updateCoupon | command | own work | ? |
|  |  | Coupon read (1 stmt) | ? |
|  |  | Coupon write (1 stmt) | ? |
| discount.updateDiscount | command | own work | ? |
|  |  | Category read (1 if addedDiscountAppliesToCategoryIds not empty stmt) | ? |
|  |  | Discount read (1, 1, 1, 1 stmt) | ? |
|  |  | Discount write (|addedDiscountAppliesToCategoryIds|, |addedDiscountAppliesToProductIds|, |addedDiscountAppliesToProductVariantIds|, |removedDiscountAppliesToCategoryIds|, |removedDiscountAppliesToProductIds|, |removedDiscountAppliesToProductVariantIds|, 1 stmt) | ? |
|  |  | Product read (1 if addedDiscountAppliesToProductIds not empty stmt) | ? |
|  |  | ProductVariant read (1 if addedDiscountAppliesToProductVariantIds not empty stmt) | ? |
| discount.Category.discounts | query | own work | ? |
|  |  | Discount read (1, 1, 1 if totalCount selected, 1 if totalCount selected stmt) | ? |
| discount._entities.Coupon | query | own work | 0.89 ms CPU |
|  |  | Coupon read (1 stmt) | 0.14 ms DB |
| discount.Coupon.discount | query | own work | ? |
|  |  | Discount read (1 stmt) | ? |
| discount.Coupon.users | query | own work | ? |
|  |  | CouponRedemption read (1, 1 if totalCount selected stmt) | ? |
|  |  | User read (1, 1 if totalCount selected stmt) | ? |
| discount._entities.Discount | query | own work | ? |
|  |  | Discount read (1 stmt) | ? |
| discount.Discount.discountAppliesToCategories | query | own work | ? |
|  |  | Category read (1, 1 if totalCount selected stmt) | ? |
|  |  | Discount read (1, 1 if totalCount selected stmt) | ? |
| discount.Discount.discountAppliesToProductVariants | query | own work | ? |
|  |  | Discount read (1, 1 if totalCount selected stmt) | ? |
|  |  | ProductVariant read (1, 1 if totalCount selected stmt) | ? |
| discount.Discount.discountAppliesToProducts | query | own work | ? |
|  |  | Discount read (1, 1 if totalCount selected stmt) | ? |
|  |  | Product read (1, 1 if totalCount selected stmt) | ? |
| discount.Discount.discountRequiresCoupon | query | own work | ? |
|  |  | Coupon read (1, 1 if totalCount selected stmt) | ? |
|  |  | CouponRedemption read (1 if caller is not an employee, or filter.userHasCoupon given, 1 if totalCount selected and (caller is not an employee, or filter.userHasCoupon given) stmt) | ? |
| discount.Discount.discountUsages | query | own work | ? |
|  |  | DiscountUsage read (1, 1 if totalCount selected stmt) | ? |
| discount._entities.DiscountUsage | query | own work | ? |
|  |  | DiscountUsage read (1 stmt) | ? |
| discount.DiscountUsage.discount | query | own work | ? |
|  |  | Discount read (1 stmt) | ? |
| discount.DiscountUsage.user | query | own work | ? |
|  |  | User read (1 stmt) | ? |
| discount.Product.discounts | query | own work | ? |
|  |  | Discount read (1, 1, 1 if totalCount selected, 1 if totalCount selected stmt) | ? |
| discount.ProductVariant.applicableDiscounts | query | own work | ? |
|  |  | Coupon read (1 stmt) | ? |
|  |  | CouponRedemption read (1 if caller authenticated stmt) | ? |
|  |  | Discount read (1, 1, 1, 1, 1 if totalCount selected stmt) | ? |
|  |  | Product read (1 stmt) | ? |
|  |  | ProductVariant read (1 stmt) | ? |
| discount.ProductVariant.discounts | query | own work | ? |
|  |  | Discount read (1, 1, 1 if totalCount selected, 1 if totalCount selected stmt) | ? |
| discount.User.coupons | query | own work | ? |
|  |  | Coupon read (1, 1 if totalCount selected stmt) | ? |
|  |  | CouponRedemption read (1, 1 if totalCount selected stmt) | ? |
| discount.User.discountUsages | query | own work | ? |
|  |  | DiscountUsage read (1, 1 if totalCount selected stmt) | ? |
| discount.on:inventory/product-item/reservation-succeeded | reaction | own work | 2.91 ms CPU |
|  |  | Discount read (1 if the order has discounts, |distinct discounts of the order| stmt) | 0.09 ms DB |
|  |  | DiscountUsage read (1 stmt) | 0.04 ms DB |
|  |  | DiscountUsage write (|distinct discounts of the order| stmt) | 0.04 ms DB |
| inventory.productItems | query | own work | ? |
|  |  | ProductItem read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| inventory.productItem | query | own work | ? |
|  |  | ProductItem read (1 stmt) | ? |
| inventory.createProductItemBatch | command | own work | 2.68 ms CPU |
|  |  | ProductItem write (|number of items in the batch| stmt) | 0.29 ms DB |
|  |  | ProductVariant read (1 stmt) | 0.29 ms DB |
| inventory.updateProductItem | command | own work | ? |
|  |  | ProductItem read (1 stmt) | ? |
|  |  | ProductItem write (1 stmt) | ? |
|  |  | ProductVariant read (1 stmt) | ? |
| inventory.deleteProductItem | command | own work | ? |
|  |  | ProductItem read (1 stmt) | ? |
|  |  | ProductItem write (1 stmt) | ? |
| inventory.reserveProductItemBatch | command | own work | ? |
|  |  | ProductItem write (1 stmt) | ? |
| inventory.ProductVariant.productItems | query | own work | ? |
|  |  | ProductItem read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| inventory.ProductVariant.inventoryCount | query | own work | 1.08 ms CPU |
|  |  | ProductItem read (1 stmt) | 2.89 ms DB |
| inventory._entities.ProductItem | query | own work | ? |
|  |  | ProductItem read (1 stmt) | ? |
| inventory.on:order/order/created | reaction | own work | 1.74 ms CPU |
|  |  | ProductItem read (1 stmt) | 8.23 ms DB |
|  |  | ProductItem write (|items of the order|, 0 stmt) | 16.45 ms DB |
| inventory.on:payment/payment/payment-enabled | reaction | own work | 1.31 ms CPU |
|  |  | ProductItem write (1 stmt) | 12.34 ms DB |
| inventory.on:payment/payment/payment-failed | reaction | own work | 0.65 ms CPU |
|  |  | ProductItem write (1 stmt) | 6.17 ms DB |
| inventory.on:shipment/shipment/status-updated | reaction | own work | 1.31 ms CPU |
|  |  | ProductItem write (0.99 stmt) | 12.34 ms DB |
| inventory.on:shipment/shipment/created | reaction | own work | 1.31 ms CPU |
|  |  | ProductItem write (0.99 stmt) | 12.34 ms DB |
| inventory.on:discount/order/validation-failed | reaction | own work | 0.65 ms CPU |
|  |  | ProductItem write (1 stmt) | 6.17 ms DB |
| invoice.invoice | query | own work | ? |
|  |  | Invoice read (1 stmt) | ? |
| invoice._entities.Invoice | query | own work | ? |
|  |  | Invoice read (1 stmt) | ? |
| invoice.Order.invoice | query | own work | ? |
|  |  | Invoice read (1 stmt) | ? |
| invoice.on:discount/order/validation-succeeded | reaction | own work | 3.36 ms CPU |
|  |  | Invoice read (1 stmt) | 0.14 ms DB |
|  |  | Invoice write (1 stmt) | 0.14 ms DB |
|  |  | User read (1 if condition stmt) | 0.14 ms DB |
|  |  | UserAddress read (1 stmt) | 0.14 ms DB |
|  |  | VendorAddress read (1 stmt) | 0.14 ms DB |
| media.getMedias | query | own work | ? |
|  |  | Media read (1 stmt) | ? |
| media.uploadMedia | command | own work | 2.68 ms CPU |
|  |  | Media write (1, 0.0 stmt) | 0.57 ms DB |
| media.Media.path | query | own work | ? |
|  |  | Media read (1 stmt) | ? |
| notification.notification | query | own work | ? |
|  |  | Notification read (1 stmt) | ? |
| notification.createNotification | command | own work | ? |
|  |  | Notification write (1 stmt) | ? |
|  |  | User read (1 stmt) | ? |
| notification.updateNotification | command | own work | ? |
|  |  | Notification read (1 stmt) | ? |
|  |  | Notification write (1 stmt) | ? |
| notification._entities.Notification | query | own work | ? |
|  |  | Notification read (1 stmt) | ? |
| notification.Notification.user | query | own work | ? |
|  |  | User read (1 stmt) | ? |
| notification.User.notifications | query | own work | 1.34 ms CPU |
|  |  | Notification read (1, 1 if totalCount selected stmt) | 0.57 ms DB |
| notification.on:notification/notification/create | reaction | own work | 2.68 ms CPU |
|  |  | Notification write (1 stmt) | 0.29 ms DB |
|  |  | User read (1 stmt) | 0.29 ms DB |
| order.order | query | own work | 1.59 ms CPU |
|  |  | Order read (1 stmt) | 0.14 ms DB |
| order.orderItem | query | own work | ? |
|  |  | Order read (1 stmt) | ? |
|  |  | OrderItem read (1 stmt) | ? |
| order.createOrder | command | own work | 5.50 ms CPU |
|  |  | Coupon read (1 if some input has coupon ids stmt) | 0.08 ms DB |
|  |  | Order write (1 stmt) | 0.08 ms DB |
|  |  | OrderItem write (|found visible variants (one INSERT per order item)|, |(item, applied discount) pairs (one INSERT each)| stmt) | 0.17 ms DB |
|  |  | ProductVariant read (1 stmt) | 0.08 ms DB |
|  |  | ProductVariantVersion read (1 stmt) | 0.08 ms DB |
|  |  | ShipmentMethod read (1 stmt) | 0.08 ms DB |
|  |  | TaxRate read (1 stmt) | 0.08 ms DB |
|  |  | TaxRateVersion read (1 stmt) | 0.08 ms DB |
|  |  | User read (1 stmt) | 0.08 ms DB |
|  |  | UserAddress read (1 stmt) | 0.08 ms DB |
| order.placeOrder | command | own work | 3.66 ms CPU |
|  |  | Order read (1 stmt) | 0.15 ms DB |
|  |  | Order write (1 if pending for less than 1 h, 1 if pending for 1 h or longer stmt) | 0.30 ms DB |
|  |  | OrderItem read (1 if placed, 1 if placed and the order has items stmt) | 0.30 ms DB |
| order._entities.Order | query | own work | 0.45 ms CPU |
|  |  | Order read (1 stmt) | 0.07 ms DB |
| order.Order.orderItems | query | own work | 1.14 ms CPU |
|  |  | OrderItem read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected and first given stmt) | 0.21 ms DB |
| order._entities.OrderItem | query | own work | ? |
|  |  | OrderItem read (1 stmt) | ? |
| order.OrderItem.discounts | query | own work | ? |
|  |  | OrderItem read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected and first given stmt) | ? |
| order.User.orders | query | own work | ? |
|  |  | Order read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| order.on:shipment/shipment/creation-failed | reaction | own work | 2.68 ms CPU |
|  |  | Order read (1 if orderId present stmt) | 0.10 ms DB |
|  |  | OrderCompensation read (1 if orderId present, 1 if orderId present stmt) | 0.19 ms DB |
|  |  | OrderCompensation write (1 if uncompensated items listed, |the compensated items (one INSERT each)| stmt) | 0.19 ms DB |
|  |  | OrderItem read (1 if orderId present stmt) | 0.10 ms DB |
| payment.paymentInformations | query | own work | ? |
|  |  | PaymentInformation read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| payment.payments | query | own work | ? |
|  |  | Payment read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
|  |  | PaymentInformation read (1 if filter.paymentMethod set (inside each selected statement) stmt) | ? |
| payment.createCreditCardPaymentInformation | command | own work | 2.68 ms CPU |
|  |  | PaymentInformation write (1 stmt) | 0.57 ms DB |
| payment.deletePaymentInformation | command | own work | ? |
|  |  | PaymentInformation read (1 stmt) | ? |
|  |  | PaymentInformation write (1 stmt) | ? |
| payment.deletePayment | command | own work | ? |
|  |  | Payment read (1 stmt) | ? |
|  |  | Payment write (1 stmt) | ? |
| payment.User.paymentInformations | query | own work | 1.49 ms CPU |
|  |  | PaymentInformation read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | 0.22 ms DB |
| payment._entities.PaymentInformation | query | own work | ? |
|  |  | PaymentInformation read (1 stmt) | ? |
| payment.PaymentInformation.payments | query | own work | ? |
|  |  | Payment read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
|  |  | PaymentInformation read (1 if filter.paymentMethod set (inside each selected statement) stmt) | ? |
| payment._entities.Payment | query | own work | ? |
|  |  | Payment read (1 stmt) | ? |
| payment.Payment.paymentInformation | query | own work | ? |
|  |  | PaymentInformation read (1 stmt) | ? |
| payment.on:discount/order/validation-succeeded | reaction | own work | 3.81 ms CPU |
|  |  | Order write (1, 0 stmt) | 0.27 ms DB |
|  |  | OrderItem write (1, 0 stmt) | 0.27 ms DB |
|  |  | Payment write (1, 0 stmt) | 0.27 ms DB |
|  |  | PaymentInformation read (1 stmt) | 0.13 ms DB |
| payment.on:user/user/created | reaction | own work | 2.27 ms CPU |
|  |  | PaymentInformation read (1, 2 stmt) | 0.24 ms DB |
|  |  | PaymentInformation write (2 if the method does not exist yet (always on the first delivery) stmt) | 0.12 ms DB |
| payment.http:/payment/update-payment-status | reaction | own work | 2.85 ms CPU |
|  |  | Order read (0.413 stmt) | 0.09 ms DB |
|  |  | OrderItem read (0.413 stmt) | 0.09 ms DB |
|  |  | Payment read (1 stmt) | 0.09 ms DB |
|  |  | Payment write (0.58, 0.413, 0.007 stmt) | 0.27 ms DB |
|  |  | PaymentInformation read (1 stmt) | 0.09 ms DB |
| payment.job:checkOpenInvoicePayments | reaction | own work | ? |
|  |  | Order read (1 stmt) | ? |
|  |  | OrderItem read (1 stmt) | ? |
|  |  | Payment read (1 stmt) | ? |
|  |  | Payment write (|overdue payments| stmt) | ? |
|  |  | PaymentInformation read (1 stmt) | ? |
| payment.job:checkOpenPrepaymentPayments | reaction | own work | ? |
|  |  | Order read (1 stmt) | ? |
|  |  | OrderItem read (1 stmt) | ? |
|  |  | Payment read (1 stmt) | ? |
|  |  | Payment write (|overdue payments| stmt) | ? |
|  |  | PaymentInformation read (1 stmt) | ? |
| return.return | query | own work | ? |
|  |  | Order read (1 stmt) | ? |
|  |  | Return read (1 stmt) | ? |
| return.returns | query | own work | ? |
|  |  | Order read (1, 1 if totalCount selected stmt) | ? |
|  |  | Return read (1, 1 if totalCount selected stmt) | ? |
| return.createReturn | command | own work | 2.68 ms CPU |
|  |  | Order read (1 stmt) | 0.07 ms DB |
|  |  | OrderItem read (1, 1 stmt) | 0.14 ms DB |
|  |  | OrderItem write (|returned items| stmt) | 0.07 ms DB |
|  |  | ProductVariantVersion read (1 stmt) | 0.07 ms DB |
|  |  | Return write (1 stmt) | 0.07 ms DB |
|  |  | Shipment read (1, 1 stmt) | 0.14 ms DB |
| return._entities.OrderItem | query | own work | ? |
|  |  | OrderItem read (1 if condition stmt) | ? |
| return.OrderItem.returnedWith | query | own work | ? |
|  |  | Return read (1 if item returned (returnedWithId set) stmt) | ? |
| return._entities.Return | query | own work | ? |
|  |  | Return read (1 stmt) | ? |
| return.Return.returnedItems | query | own work | ? |
|  |  | OrderItem read (1, 1 if totalCount selected stmt) | ? |
| return.User.returns | query | own work | ? |
|  |  | Order read (1, 1 if totalCount selected stmt) | ? |
|  |  | Return read (1, 1 if totalCount selected stmt) | ? |
| review.reviews | query | own work | ? |
|  |  | Review read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| review.review | query | own work | ? |
|  |  | Review read (1 if condition stmt) | ? |
| review.createReview | command | own work | 1.84 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.12 ms DB |
|  |  | Review read (1 stmt) | 0.12 ms DB |
|  |  | Review write (1 stmt) | 0.12 ms DB |
|  |  | User read (1 stmt) | 0.12 ms DB |
| review.updateReview | command | own work | ? |
|  |  | Review read (1 stmt) | ? |
|  |  | Review write (1 if a field is set in the input stmt) | ? |
| review.deleteReview | command | own work | ? |
|  |  | Review read (1 stmt) | ? |
|  |  | Review write (1 stmt) | ? |
| review._entities.Product | query | own work | ? |
|  |  | Product read (1 stmt) | ? |
| review.Product.reviews | query | own work | ? |
|  |  | Review read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| review.Product.averageRating | query | own work | ? |
|  |  | Review read (1 stmt) | ? |
| review._entities.ProductVariant | query | own work | 0.72 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.09 ms DB |
| review.ProductVariant.reviews | query | own work | ? |
|  |  | Review read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| review.ProductVariant.averageRating | query | own work | 0.72 ms CPU |
|  |  | Review read (1 stmt) | 0.09 ms DB |
| review._entities.User | query | own work | ? |
|  |  | User read (1 stmt) | ? |
| review.User.reviews | query | own work | ? |
|  |  | Review read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| shipment.calculateShipmentFees | query | own work | 1.93 ms CPU |
|  |  | ProductVariantVersion read (|shipment method groups of the input| stmt) | 0.77 ms DB |
|  |  | ShipmentMethod read (1 stmt) | 0.77 ms DB |
| shipment.shipmentMethod | query | own work | 0.45 ms CPU |
|  |  | ShipmentMethod read (1 stmt) | 0.07 ms DB |
| shipment.shipmentMethods | query | own work | 2.60 ms CPU |
|  |  | ShipmentMethod read (1, 1 if totalCount selected stmt) | 2.37 ms DB |
| shipment.createShipmentMethod | command | own work | 2.68 ms CPU |
|  |  | ShipmentMethod write (1 stmt) | 0.57 ms DB |
| shipment.archiveShipmentMethod | command | own work | ? |
|  |  | ShipmentMethod read (1 stmt) | ? |
|  |  | ShipmentMethod write (1 stmt) | ? |
| shipment.Order.shipments | query | own work | 0.96 ms CPU |
|  |  | Shipment read (1, 1 if totalCount selected stmt) | 0.05 ms DB |
| shipment._entities.OrderItem | query | own work | ? |
|  |  | OrderItem read (1 if condition stmt) | ? |
| shipment.OrderItem.sentWith | query | own work | ? |
|  |  | Shipment read (1 if sentWithId known stmt) | ? |
| shipment.Return.shipment | query | own work | ? |
|  |  | Shipment read (1 if condition stmt) | ? |
| shipment._entities.Shipment | query | own work | 0.89 ms CPU |
|  |  | Shipment read (1 stmt) | 0.14 ms DB |
| shipment.Shipment.sentItems | query | own work | ? |
|  |  | OrderItem read (1, 1 if totalCount selected stmt) | ? |
|  |  | Shipment read (1, 1 if totalCount selected stmt) | ? |
| shipment.Shipment.shipmentAddress | query | own work | ? |
|  |  | UserAddress read (1 stmt) | ? |
| shipment.Shipment.shipmentMethod | query | own work | ? |
|  |  | ShipmentMethod read (1 stmt) | ? |
| shipment._entities.ShipmentMethod | query | own work | 0.45 ms CPU |
|  |  | ShipmentMethod read (1 stmt) | 0.07 ms DB |
| shipment.ShipmentMethod.calculateFees | query | own work | ? |
|  |  | ProductVariantVersion read (1 stmt) | ? |
| shipment.on:payment/payment/payment-enabled | reaction | own work | 4.41 ms CPU |
|  |  | OrderItem write (|items of the order|, 0 stmt) | 1.54 ms DB |
|  |  | ProductVariantVersion read (|shipment method groups of the order| stmt) | 0.77 ms DB |
|  |  | Shipment read (1, 1 stmt) | 1.54 ms DB |
|  |  | Shipment write (|shipment method groups of the order|, |items of the order|, 0, 0 stmt) | 3.08 ms DB |
|  |  | ShipmentMethod read (|shipment method groups of the order| stmt) | 0.77 ms DB |
|  |  | UserAddress read (|shipment method groups of the order|, |shipment method groups of the order| stmt) | 1.54 ms DB |
| shipment.on:return/return/created | reaction | own work | 2.68 ms CPU |
|  |  | OrderItem read (1 stmt) | 0.04 ms DB |
|  |  | ProductVariantVersion read (2 stmt) | 0.04 ms DB |
|  |  | Shipment read (1, 1 stmt) | 0.09 ms DB |
|  |  | Shipment write (1, |returned items|, 0, 0 stmt) | 0.18 ms DB |
|  |  | ShipmentMethod read (1, 1 stmt) | 0.09 ms DB |
|  |  | VendorAddress read (1, 1, 1 stmt) | 0.13 ms DB |
| shipment.http:/shipment/{id}/status | reaction | own work | 3.31 ms CPU |
|  |  | Shipment read (1, 1 stmt) | 4.11 ms DB |
|  |  | Shipment write (1 stmt) | 2.05 ms DB |
| shoppingcart.shoppingcartItem | query | own work | ? |
|  |  | ShoppingCartItem read (1 stmt) | ? |
| shoppingcart.updateShoppingcart | command | own work | ? |
|  |  | ProductVariant read (1 if shoppingCartItems given and not empty stmt) | ? |
|  |  | ShoppingCart read (1 stmt) | ? |
|  |  | ShoppingCart write (1 if shoppingCartItems given stmt) | ? |
|  |  | ShoppingCartItem write (1 if shoppingCartItems given, |distinct (count, productVariantId) pairs of the input| stmt) | ? |
| shoppingcart.createShoppingcartItem | command | own work | 2.76 ms CPU |
|  |  | ProductVariant read (1 stmt) | 0.17 ms DB |
|  |  | ShoppingCart read (1 stmt) | 0.17 ms DB |
|  |  | ShoppingCart write (1 if no item of the variant in the cart stmt) | 0.17 ms DB |
|  |  | ShoppingCartItem read (1 if condition stmt) | 0.17 ms DB |
|  |  | ShoppingCartItem write (1 if no item of the variant in the cart stmt) | 0.17 ms DB |
| shoppingcart.updateShoppingcartItem | command | own work | ? |
|  |  | ShoppingCart write (1 stmt) | ? |
|  |  | ShoppingCartItem read (1 stmt) | ? |
|  |  | ShoppingCartItem write (1 stmt) | ? |
| shoppingcart.deleteShoppingcartItem | command | own work | ? |
|  |  | ShoppingCart write (1 stmt) | ? |
|  |  | ShoppingCartItem read (1 stmt) | ? |
|  |  | ShoppingCartItem write (1 stmt) | ? |
| shoppingcart.ShoppingCart.shoppingcartItems | query | own work | ? |
|  |  | ShoppingCartItem read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected and first given stmt) | ? |
| shoppingcart._entities.ShoppingCartItem | query | own work | ? |
|  |  | ShoppingCartItem read (1 stmt) | ? |
| shoppingcart._entities.User | query | own work | 1.04 ms CPU |
|  |  | ShoppingCart read (1 stmt) | 0.27 ms DB |
| shoppingcart.on:user/user/created | reaction | own work | ? |
|  |  | ShoppingCart write (1 stmt) | ? |
| shoppingcart.on:order/order/created | reaction | own work | 1.57 ms CPU |
|  |  | ShoppingCart write (1 if at least one item deleted stmt) | 0.16 ms DB |
|  |  | ShoppingCartItem write (1 if order has items stmt) | 0.16 ms DB |
| tax.taxRate | query | own work | 0.45 ms CPU |
|  |  | TaxRate read (1 stmt) | 0.07 ms DB |
| tax.taxRateVersion | query | own work | ? |
|  |  | TaxRateVersion read (1 stmt) | ? |
| tax.taxRates | query | own work | ? |
|  |  | TaxRate read (1, 1 if totalCount selected stmt) | ? |
| tax.createTaxRate | command | own work | 2.68 ms CPU |
|  |  | TaxRate write (1, 1 stmt) | 0.29 ms DB |
|  |  | TaxRateVersion read (1 stmt) | 0.14 ms DB |
|  |  | TaxRateVersion write (1 stmt) | 0.14 ms DB |
| tax.createTaxRateVersion | command | own work | 2.68 ms CPU |
|  |  | TaxRate read (1, 1 stmt) | 0.23 ms DB |
|  |  | TaxRate write (1 stmt) | 0.11 ms DB |
|  |  | TaxRateVersion read (1 stmt) | 0.11 ms DB |
|  |  | TaxRateVersion write (1 stmt) | 0.11 ms DB |
| tax.updateTaxRate | command | own work | ? |
|  |  | TaxRate read (1 stmt) | ? |
|  |  | TaxRate write (1 stmt) | ? |
| tax._entities.TaxRate | query | own work | 0.45 ms CPU |
|  |  | TaxRate read (1 stmt) | 0.07 ms DB |
| tax.TaxRate.currentVersion | query | own work | ? |
|  |  | TaxRateVersion read (1 stmt) | ? |
| tax.TaxRate.versions | query | own work | ? |
|  |  | TaxRateVersion read (1, 1 if totalCount selected stmt) | ? |
| tax._entities.TaxRateVersion | query | own work | ? |
|  |  | TaxRateVersion read (1 stmt) | ? |
| tax.TaxRateVersion.taxRate | query | own work | ? |
|  |  | TaxRate read (1 stmt) | ? |
| user.currentUser | query | own work | 5.43 ms CPU |
|  |  | User read (1 stmt) | 0.53 ms DB |
| user.user | query | own work | 0.45 ms CPU |
|  |  | User read (1 stmt) | 0.07 ms DB |
| user.users | query | own work | ? |
|  |  | User read (1, 1 if totalCount selected stmt) | ? |
| user.updateUser | command | own work | 2.68 ms CPU |
|  |  | User read (1 stmt) | 0.29 ms DB |
|  |  | User write (1 stmt) | 0.29 ms DB |
| user._entities.User | query | own work | 0.45 ms CPU |
|  |  | User read (1 stmt) | 0.07 ms DB |
| user.on:user/user/create | reaction | own work | 3.30 ms CPU |
|  |  | User read (1 stmt) | 0.12 ms DB |
|  |  | User write (1 stmt) | 0.12 ms DB |
| wishlist.wishlist | query | own work | 1.74 ms CPU |
|  |  | Wishlist read (1 stmt) | 0.01 ms DB |
| wishlist.createWishlist | command | own work | 2.68 ms CPU |
|  |  | ProductVariant read (1 if productVariantIds not empty stmt) | 0.14 ms DB |
|  |  | User read (1 stmt) | 0.14 ms DB |
|  |  | Wishlist write (1, 1 if productVariantIds not empty stmt) | 0.29 ms DB |
| wishlist.updateWishlist | command | own work | 4.57 ms CPU |
|  |  | ProductVariant read (1 if productVariantIds given and not empty stmt) | 0.01 ms DB |
|  |  | Wishlist read (1 stmt) | 0.01 ms DB |
|  |  | Wishlist write (1 if productVariantIds given, 1 if productVariantIds given and not empty, 1 if productVariantIds or name given stmt) | 0.03 ms DB |
| wishlist.deleteWishlist | command | own work | ? |
|  |  | Wishlist read (1 stmt) | ? |
|  |  | Wishlist write (1, 1 stmt) | ? |
| wishlist._entities.User | query | own work | ? |
|  |  | User read (1 stmt) | ? |
| wishlist.User.wishlists | query | own work | ? |
|  |  | Wishlist read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected stmt) | ? |
| wishlist._entities.Wishlist | query | own work | ? |
|  |  | Wishlist read (1 stmt) | ? |
| wishlist.Wishlist.productVariants | query | own work | 1.74 ms CPU |
|  |  | ProductVariant read (1 if nodes selected, 1 if totalCount selected stmt) | 0.02 ms DB |
|  |  | Wishlist read (1 if nodes selected, 1 if totalCount selected, 1 if hasNextPage selected and first given stmt) | 0.03 ms DB |

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

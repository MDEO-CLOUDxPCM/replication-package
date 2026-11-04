-- Port of the MongoDB database `order-database` of the Rust order service (see docs/specs/order.md §9).
-- Timestamps hold millisecond precision values (BSON DateTime). u64/u32 values are stored as bigint.

-- users: replica fed by user/user/created; user_address_ids by address/user-address/created|archived ($push/$pull)
CREATE TABLE users (
    id               uuid PRIMARY KEY,
    user_address_ids uuid[] NOT NULL DEFAULT '{}'
);

-- coupons: replica fed by discount/coupon/created
CREATE TABLE coupons (
    id uuid PRIMARY KEY
);

-- shipment_methods: replica fed by shipment/shipment-method/created
CREATE TABLE shipment_methods (
    id uuid PRIMARY KEY
);

-- product_variants: replica fed by catalog/product-variant-version/created (current version)
-- and catalog/product-variant/updated (visibility; visibility_raw = a string value the original would have $set)
CREATE TABLE product_variants (
    id                          uuid PRIMARY KEY,
    current_version_id          uuid             NOT NULL,
    current_version_price       bigint           NOT NULL,
    current_version_tax_rate_id uuid             NOT NULL,
    is_publicly_visible         boolean          NOT NULL,
    visibility_raw              text
);

-- tax_rates: replica fed by tax/tax-rate-version/created (current version, upsert)
CREATE TABLE tax_rates (
    id                      uuid PRIMARY KEY,
    current_version_id      uuid             NOT NULL,
    current_version_rate    double precision NOT NULL,
    current_version_version bigint           NOT NULL
);

-- orders (owned)
CREATE TABLE orders (
    id                         uuid PRIMARY KEY,
    user_id                    uuid        NOT NULL,
    created_at                 timestamptz NOT NULL,
    order_status               text        NOT NULL,
    placed_at                  timestamptz,
    rejection_reason           text,
    shipment_address_id        uuid        NOT NULL,
    invoice_address_id         uuid        NOT NULL,
    compensatable_order_amount bigint      NOT NULL,
    payment_information_id     uuid        NOT NULL,
    vat_number                 text
);
CREATE INDEX orders_user_id_idx ON orders (user_id);

-- order_items: orders.internal_order_items[] (embedded in the original)
CREATE TABLE order_items (
    id                                  uuid PRIMARY KEY,
    order_id                            uuid             NOT NULL REFERENCES orders (id),
    position                            int              NOT NULL,
    created_at                          timestamptz      NOT NULL,
    product_variant_id                  uuid             NOT NULL,
    product_variant_is_publicly_visible boolean          NOT NULL,
    product_variant_version_id          uuid             NOT NULL,
    product_variant_version_price       bigint           NOT NULL,
    product_variant_version_tax_rate_id uuid             NOT NULL,
    tax_rate_version_id                 uuid             NOT NULL,
    tax_rate_version_rate               double precision NOT NULL,
    tax_rate_version_version            bigint           NOT NULL,
    shopping_cart_item_id               uuid             NOT NULL,
    count                               bigint           NOT NULL,
    compensatable_amount                bigint           NOT NULL,
    shipment_method_id                  uuid             NOT NULL
);
CREATE INDEX order_items_order_id_idx ON order_items (order_id);

-- order_item_discounts: internal_order_items[].internal_discounts (BTreeSet by id)
CREATE TABLE order_item_discounts (
    order_item_id uuid             NOT NULL REFERENCES order_items (id),
    discount_id   uuid             NOT NULL,
    discount      double precision NOT NULL,
    PRIMARY KEY (order_item_id, discount_id)
);

-- order_compensations (owned, written by the unsubscribed shipment/shipment/creation-failed route)
CREATE TABLE order_compensations (
    id                   uuid PRIMARY KEY,
    order_id             uuid        NOT NULL,
    order_item_ids       uuid[]      NOT NULL,
    triggered_at         timestamptz NOT NULL,
    amount_to_compensate bigint      NOT NULL
);

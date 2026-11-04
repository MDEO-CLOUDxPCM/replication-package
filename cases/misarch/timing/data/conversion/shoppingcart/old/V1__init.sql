-- MongoDB `shoppingcart-database` -> Postgres (see docs/specs/shoppingcart.md, section 6)

-- collection `product_variants` ({_id}), fed by catalog/product-variant/created
CREATE TABLE ProductVariantEntity
(
    id UUID PRIMARY KEY
);

-- collection `users` ({_id, shoppingcart: {last_updated_at, internal_shoppingcart_items}}), fed by user/user/created;
-- the embedded shopping cart is flattened into the user row
CREATE TABLE UserEntity
(
    id                        UUID PRIMARY KEY,
    shoppingcartLastUpdatedAt TIMESTAMPTZ NOT NULL
);

-- embedded array `shoppingcart.internal_shoppingcart_items` -> child table (order not observable: output is sorted by id)
CREATE TABLE ShoppingCartItemEntity
(
    id               UUID PRIMARY KEY,
    userId           UUID        NOT NULL REFERENCES UserEntity (id),
    count            BIGINT      NOT NULL,
    addedAt          TIMESTAMPTZ NOT NULL,
    -- no foreign key: the original's validation quirk lets unknown product variant ids into carts
    productVariantId UUID        NOT NULL
);

CREATE INDEX ShoppingCartItemEntity_userId_idx ON ShoppingCartItemEntity (userId);

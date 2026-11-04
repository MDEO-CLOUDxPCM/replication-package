-- MongoDB `wishlist-database` -> Postgres (see docs/specs/wishlist.md, section 5)

-- collection `users` ({_id}), fed by user/user/created
CREATE TABLE UserEntity
(
    id UUID PRIMARY KEY
);

-- collection `product_variants` ({_id}), fed by catalog/product-variant/created
CREATE TABLE ProductVariantEntity
(
    id UUID PRIMARY KEY
);

-- collection `wishlists` ({_id, user: {_id}, name, created_at, last_updated_at, internal_product_variants: [{_id}]});
-- the variant set is only ever read and written as a whole -> UUID[] (no foreign keys: the original's validation
-- quirk lets unknown product variant ids in, and users are only checked on creation)
CREATE TABLE WishlistEntity
(
    id                UUID PRIMARY KEY,
    userId            UUID        NOT NULL,
    name              VARCHAR     NOT NULL,
    createdAt         TIMESTAMPTZ NOT NULL,
    lastUpdatedAt     TIMESTAMPTZ NOT NULL,
    productVariantIds UUID[]      NOT NULL
);

CREATE INDEX WishlistEntity_userId_idx ON WishlistEntity (userId);

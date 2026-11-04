-- Port of the MongoDB collections of the original review service (database `review-database`).
-- See docs/specs/review.md §7.

-- users {_id}: replica fed by user/user/created
CREATE TABLE users (
    id uuid PRIMARY KEY
);

-- products {_id}: replica fed by catalog/product/created
CREATE TABLE products (
    id uuid PRIMARY KEY
);

-- product_variants {_id, product_id}: only written by the (unsubscribed) /on-product-variant-creation-event route
CREATE TABLE product_variants (
    id         uuid PRIMARY KEY,
    product_id uuid NOT NULL
);

-- reviews {_id, user{_id}, product_variant{_id, product_id}, body, rating, created_at, last_updated_at, is_visible}
-- rating holds the stored token: OneStars|TwoStars|ThreeStars|FourStars|FiveStars (insert) and FourStarst (update quirk)
CREATE TABLE reviews (
    id                         uuid PRIMARY KEY,
    user_id                    uuid        NOT NULL,
    product_variant_id         uuid        NOT NULL,
    product_variant_product_id uuid        NOT NULL,
    body                       text        NOT NULL,
    rating                     text        NOT NULL,
    created_at                 timestamptz NOT NULL,
    last_updated_at            timestamptz NOT NULL,
    is_visible                 boolean     NOT NULL
);

CREATE INDEX reviews_user_id_idx ON reviews (user_id);
CREATE INDEX reviews_product_variant_id_idx ON reviews (product_variant_id);
CREATE INDEX reviews_product_variant_product_id_idx ON reviews (product_variant_product_id);

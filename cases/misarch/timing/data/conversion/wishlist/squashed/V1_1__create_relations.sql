CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE UserEntity (
    id UUID PRIMARY KEY
);

CREATE TABLE ProductVariantEntity (
    id UUID PRIMARY KEY
);

CREATE TABLE WishlistEntity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    userId UUID NOT NULL,
    name VARCHAR NOT NULL,
    createdAt TIMESTAMPTZ NOT NULL,
    lastUpdatedAt TIMESTAMPTZ NOT NULL
);
CREATE INDEX wishlistEntity_userId ON WishlistEntity (userId);

-- no foreign key on productVariantId: a wishlist may hold a product variant this service has not received
CREATE TABLE WishlistToProductVariantEntity (
    wishlistId UUID NOT NULL,
    productVariantId UUID NOT NULL,
    PRIMARY KEY (wishlistId, productVariantId),
    FOREIGN KEY (wishlistId) REFERENCES WishlistEntity(id)
);

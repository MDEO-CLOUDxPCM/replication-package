-- Relational port (docs/specs/wishlist.md section 5, docs/PORTING.md §6 "Former MongoDB services"): the variant set of
-- a wishlist (`internal_product_variants`, formerly the array WishlistEntity.productVariantIds) becomes a link table,
-- read by `Wishlist.productVariants` as a connection and written row by row (like the Kotlin services' link tables).
-- No foreign key to ProductVariantEntity: the original's validation quirk let unknown product variant ids in.
CREATE TABLE WishlistToProductVariantEntity
(
    wishlistId       UUID NOT NULL REFERENCES WishlistEntity (id),
    productVariantId UUID NOT NULL,
    PRIMARY KEY (wishlistId, productVariantId)
);

INSERT INTO WishlistToProductVariantEntity (wishlistId, productVariantId)
SELECT DISTINCT w.id, v.productVariantId
FROM WishlistEntity w, unnest(w.productVariantIds) AS v(productVariantId);

ALTER TABLE WishlistEntity DROP COLUMN productVariantIds;

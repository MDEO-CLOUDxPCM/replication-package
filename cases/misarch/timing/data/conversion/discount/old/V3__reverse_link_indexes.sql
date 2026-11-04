-- Index fix (performance-visible): the order validation path (findApplicableDiscounts, once per item of every order)
-- and the Category/Product/ProductVariant.discounts connections look the link tables up by their second column
-- (... WHERE productVariantId = ?, productId = ?, categoryId = ?) and check NOT EXISTS (... CouponEntity WHERE
-- discountId = t.id); the primary keys lead with discountId and CouponEntity.discountId had no index, so each of these
-- lookups scanned the whole table.
CREATE INDEX discountToProductVariantEntity_productVariantId ON DiscountToProductVariantEntity (productVariantId);
CREATE INDEX discountToProductEntity_productId ON DiscountToProductEntity (productId);
CREATE INDEX discountToCategoryEntity_categoryId ON DiscountToCategoryEntity (categoryId);
CREATE INDEX couponEntity_discountId ON CouponEntity (discountId);

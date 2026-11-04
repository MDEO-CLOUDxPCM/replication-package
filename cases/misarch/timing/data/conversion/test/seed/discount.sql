INSERT INTO UserEntity (id) VALUES ('82000000-0000-4000-8000-000000000001');
INSERT INTO ProductEntity (id) VALUES ('82000000-0000-4000-8000-0000000000b1');
INSERT INTO ProductVariantEntity (id, productId) VALUES ('82000000-0000-4000-8000-0000000000b2', '82000000-0000-4000-8000-0000000000b1');
INSERT INTO CategoryEntity (id) VALUES ('82000000-0000-4000-8000-0000000000c1');
INSERT INTO ProductToCategoryEntity (id, productId, categoryId) VALUES (gen_random_uuid(), '82000000-0000-4000-8000-0000000000b1', '82000000-0000-4000-8000-0000000000c1');
INSERT INTO DiscountEntity (id, discount, maxUsagesPerUser, validFrom, validUntil) VALUES ('82000000-0000-4000-8000-0000000000d1', 0.1, 3, now(), now() + interval '1 day');
INSERT INTO CouponEntity (id, maxUsages, validFrom, validUntil, code, discountId)
    VALUES ('82000000-0000-4000-8000-0000000000e1', 2, now(), now() + interval '1 day', 'WELCOME', '82000000-0000-4000-8000-0000000000d1');
INSERT INTO CouponRedemptionEntity (id, couponId, userId) VALUES (gen_random_uuid(), '82000000-0000-4000-8000-0000000000e1', '82000000-0000-4000-8000-000000000001');
INSERT INTO DiscountToProductEntity (id, discountId, productId) VALUES (gen_random_uuid(), '82000000-0000-4000-8000-0000000000d1', '82000000-0000-4000-8000-0000000000b1');
INSERT INTO DiscountToCategoryEntity (id, discountId, categoryId) VALUES (gen_random_uuid(), '82000000-0000-4000-8000-0000000000d1', '82000000-0000-4000-8000-0000000000c1');
INSERT INTO DiscountToProductVariantEntity (id, discountId, productVariantId) VALUES (gen_random_uuid(), '82000000-0000-4000-8000-0000000000d1', '82000000-0000-4000-8000-0000000000b2');
INSERT INTO DiscountUsageEntity (discountId, userId, usages) VALUES ('82000000-0000-4000-8000-0000000000d1', '82000000-0000-4000-8000-000000000001', 1);

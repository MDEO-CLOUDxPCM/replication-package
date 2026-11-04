DO $$ BEGIN
    ASSERT (SELECT usages FROM CouponEntity) = 1, 'coupon usages';
    ASSERT (SELECT count(*) FROM CouponRedemptionEntity) + (SELECT count(*) FROM DiscountToProductEntity)
         + (SELECT count(*) FROM DiscountToCategoryEntity) + (SELECT count(*) FROM DiscountToProductVariantEntity)
         + (SELECT count(*) FROM ProductToCategoryEntity) = 5, 'links';
    INSERT INTO UserEntity (id) VALUES ('82000000-0000-4000-8000-000000000002');
    INSERT INTO CouponRedemptionEntity (couponId, userId) VALUES ('82000000-0000-4000-8000-0000000000e1', '82000000-0000-4000-8000-000000000002');
    ASSERT (SELECT usages FROM CouponEntity) = 2, 'redemption trigger';
    BEGIN
        UPDATE DiscountUsageEntity SET usages = 4;
        RAISE EXCEPTION 'usage over maxUsagesPerUser accepted';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
END $$;

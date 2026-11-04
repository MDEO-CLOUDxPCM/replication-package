-- User.coupons (CouponRedemptionEntity WHERE userId = ?) and User.discountUsages (DiscountUsageEntity WHERE
-- userId = ?) scanned the whole tables: both unique constraints lead with the coupon or discount id. The tables grow
-- with every redemption and order.
CREATE INDEX couponRedemptionEntity_userId ON CouponRedemptionEntity (userId);
CREATE INDEX discountUsageEntity_userId ON DiscountUsageEntity (userId);

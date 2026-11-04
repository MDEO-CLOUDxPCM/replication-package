-- Link tables: the natural key (both foreign keys) becomes the primary key instead of a technical id that nothing
-- read. The former UNIQUE (a, b) constraint is replaced by the primary key (same columns). Its generated name is
-- looked up because Postgres shortens names longer than 63 characters. DiscountUsageEntity keeps its id (it is the
-- id of the GraphQL type DiscountUsage).

ALTER TABLE ProductToCategoryEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE ProductToCategoryEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'producttocategoryentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE ProductToCategoryEntity ADD PRIMARY KEY (productId, categoryId);

ALTER TABLE CouponRedemptionEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE CouponRedemptionEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'couponredemptionentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE CouponRedemptionEntity ADD PRIMARY KEY (couponId, userId);

ALTER TABLE DiscountToProductEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE DiscountToProductEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'discounttoproductentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE DiscountToProductEntity ADD PRIMARY KEY (discountId, productId);

ALTER TABLE DiscountToCategoryEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE DiscountToCategoryEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'discounttocategoryentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE DiscountToCategoryEntity ADD PRIMARY KEY (discountId, categoryId);

ALTER TABLE DiscountToProductVariantEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE DiscountToProductVariantEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'discounttoproductvariantentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE DiscountToProductVariantEntity ADD PRIMARY KEY (discountId, productVariantId);

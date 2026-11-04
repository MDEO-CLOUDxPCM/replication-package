-- Link tables: the natural key (both foreign keys) becomes the primary key instead of a technical id that nothing
-- read. The former UNIQUE (a, b) constraint is replaced by the primary key (same columns, NOT NULL implied). Its
-- generated name is looked up because Postgres shortens names longer than 63 characters.
ALTER TABLE ProductToCategoryEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE ProductToCategoryEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'producttocategoryentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE ProductToCategoryEntity ADD PRIMARY KEY (productId, categoryId);

ALTER TABLE ProductVariantVersionToMediaEntity DROP COLUMN id;
DO $$ BEGIN
    EXECUTE (SELECT format('ALTER TABLE ProductVariantVersionToMediaEntity DROP CONSTRAINT %I', conname)
             FROM pg_constraint WHERE conrelid = 'productvariantversiontomediaentity'::regclass AND contype = 'u');
END $$;
ALTER TABLE ProductVariantVersionToMediaEntity ADD PRIMARY KEY (productVariantVersionId, mediaId);

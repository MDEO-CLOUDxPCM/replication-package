-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255); default names for the
-- foreign keys that had their own
ALTER TABLE CategoryEntity ALTER COLUMN name TYPE TEXT, ALTER COLUMN description TYPE TEXT;
ALTER TABLE CategoryCharacteristicEntity
    ALTER COLUMN discriminator TYPE TEXT, ALTER COLUMN name TYPE TEXT, ALTER COLUMN description TYPE TEXT,
    ALTER COLUMN unit TYPE TEXT;
ALTER TABLE CategoryCharacteristicValueEntity ALTER COLUMN discriminator TYPE TEXT, ALTER COLUMN stringValue TYPE TEXT;
ALTER TABLE ProductEntity ALTER COLUMN internalName TYPE TEXT;
ALTER TABLE ProductVariantVersionEntity ALTER COLUMN name TYPE TEXT, ALTER COLUMN description TYPE TEXT;
ALTER TABLE ProductEntity RENAME CONSTRAINT fk_product_default_variant TO productEntity_defaultVariantId_fkey;
ALTER TABLE ProductVariantEntity RENAME CONSTRAINT fk_product_variant_version TO productVariantEntity_currentVersion_fkey;
ALTER TABLE ProductVariantVersionEntity RENAME CONSTRAINT fk_tax_rate_od TO productVariantVersionEntity_taxRateId_fkey;

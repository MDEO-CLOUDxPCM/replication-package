-- Foreign keys that the service always sets were nullable in SQL; the entities declare
-- them non-null. Fails (and the migration rolls back) if a row with a NULL exists.
ALTER TABLE CategoryCharacteristicEntity ALTER COLUMN categoryId SET NOT NULL;
ALTER TABLE ProductVariantEntity ALTER COLUMN productId SET NOT NULL;
ALTER TABLE ProductVariantVersionEntity ALTER COLUMN productVariantId SET NOT NULL;
ALTER TABLE ProductVariantVersionEntity ALTER COLUMN taxRateId SET NOT NULL;
ALTER TABLE CategoryCharacteristicValueEntity ALTER COLUMN categoryCharacteristicId SET NOT NULL;
ALTER TABLE CategoryCharacteristicValueEntity ALTER COLUMN productVariantVersionId SET NOT NULL;

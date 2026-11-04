ALTER TABLE OrderItemEntity DROP COLUMN productVariantVersion;
ALTER TABLE OrderItemEntity ADD COLUMN productVariantVersionId UUID NOT NULL;
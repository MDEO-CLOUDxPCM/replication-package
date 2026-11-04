-- Lookups by foreign key without an index scanned whole tables, so their cost grew with the catalog:
-- * the next version number (SELECT MAX(version) ... WHERE productVariantId = ?, every version creation) and
--   ProductVariant.versions: 68k versions, 3.3 ms;
-- * Product.variants (COUNT and page WHERE productId = ?): 34k variants, 1 ms per statement;
-- * ProductVariantVersion.characteristicValues (WHERE productVariantVersionId = ?): 415k values; the unique
--   constraint leads with categoryCharacteristicId and does not help;
-- * Category.products (ProductToCategoryEntity WHERE categoryId = ?): the unique constraint leads with productId.
CREATE INDEX productVariantVersionEntity_variant_version ON ProductVariantVersionEntity (productVariantId, version);
CREATE INDEX productVariantEntity_productId ON ProductVariantEntity (productId);
CREATE INDEX categoryCharacteristicValueEntity_version ON CategoryCharacteristicValueEntity (productVariantVersionId);
CREATE INDEX productToCategoryEntity_categoryId ON ProductToCategoryEntity (categoryId);

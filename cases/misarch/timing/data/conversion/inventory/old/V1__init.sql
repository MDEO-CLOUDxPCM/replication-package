-- MongoDB collection `productitems` of the original: {_id: string, productVariant: string (Mixed), inventoryStatus, orderId?}
-- Ids stay TEXT: the original compares Mongo string ids case-sensitively and sorts them byte-wise (COLLATE "C").
-- productVariant is nullable because the original's release upsert inserts "phantom" items without it.
-- seq reproduces Mongo's natural (insertion) order for unsorted reads.
CREATE TABLE ProductItemEntity (
    id              TEXT COLLATE "C" PRIMARY KEY,
    productVariant  TEXT COLLATE "C",
    inventoryStatus TEXT NOT NULL,
    orderId         TEXT COLLATE "C",
    seq             BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX productItemEntity_variant_status ON ProductItemEntity (productVariant, inventoryStatus);
CREATE INDEX productItemEntity_orderId ON ProductItemEntity (orderId);

-- MongoDB collection `productvariantpartials`: {_id: string} replicated from catalog/product-variant/created
CREATE TABLE ProductVariantPartialEntity (
    id TEXT COLLATE "C" PRIMARY KEY
);

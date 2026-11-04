-- unify 9e4cd77's final schema -> V1_1__create_relations.sql: seq becomes insertionOrder (BIGSERIAL, without the
-- unused UNIQUE constraint); the values are kept and the sequence continues after the largest one
ALTER TABLE ProductItemEntity DROP CONSTRAINT productItemEntity_seq_key;
ALTER TABLE ProductItemEntity ALTER COLUMN seq DROP IDENTITY;
ALTER TABLE ProductItemEntity RENAME COLUMN seq TO insertionOrder;
CREATE SEQUENCE productItemEntity_insertionOrder_seq OWNED BY ProductItemEntity.insertionOrder;
ALTER TABLE ProductItemEntity ALTER COLUMN insertionOrder SET DEFAULT nextval('productItemEntity_insertionOrder_seq');
SELECT setval('productItemEntity_insertionOrder_seq', COALESCE((SELECT MAX(insertionOrder) FROM ProductItemEntity), 0) + 1, false);
ALTER INDEX productItemEntity_productVariantId_inventoryStatus_seq RENAME TO productItemEntity_variant_status_insertionOrder;

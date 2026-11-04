-- unify 9e4cd77's final schema -> V1_1__create_relations.sql
ALTER TABLE ReviewEntity ADD CONSTRAINT reviewEntity_userId_productVariantId_key
    UNIQUE USING INDEX reviewEntity_userId_productVariantId_key;
-- the unique (userId, productVariantId) serves the lookups by userId
DROP INDEX reviewEntity_userId;

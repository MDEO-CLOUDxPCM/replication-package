-- UUID ids and `...Id` column names like the other services (the TEXT ids came from the MongoDB original).
-- Fails loudly if a stored id is not a UUID (only possible with hand-made data); nothing is changed then.
DO $$
DECLARE
    uuid_pattern CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
    IF EXISTS (SELECT 1 FROM ProductItemEntity
               WHERE id !~ uuid_pattern OR productVariant !~ uuid_pattern OR orderId !~ uuid_pattern) THEN
        RAISE EXCEPTION 'ProductItemEntity contains ids that are not UUIDs; fix them before migrating';
    END IF;
    IF EXISTS (SELECT 1 FROM ProductVariantPartialEntity WHERE id !~ uuid_pattern) THEN
        RAISE EXCEPTION 'ProductVariantPartialEntity contains ids that are not UUIDs; fix them before migrating';
    END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- "phantom" items without product variant were inserted by the original's release upsert (fixed since V1)
DELETE FROM ProductItemEntity WHERE productVariant IS NULL;

ALTER TABLE ProductItemEntity
    ALTER COLUMN id TYPE UUID USING id::uuid,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4(),
    ALTER COLUMN productVariant TYPE UUID USING productVariant::uuid,
    ALTER COLUMN productVariant SET NOT NULL,
    ALTER COLUMN orderId TYPE UUID USING orderId::uuid;
ALTER TABLE ProductItemEntity RENAME COLUMN productVariant TO productVariantId;
ALTER INDEX productItemEntity_variant_status_seq RENAME TO productItemEntity_productVariantId_inventoryStatus_seq;

ALTER TABLE ProductVariantPartialEntity ALTER COLUMN id TYPE UUID USING id::uuid;
ALTER TABLE ProductVariantPartialEntity RENAME TO ProductVariantEntity;
ALTER INDEX productVariantPartialEntity_pkey RENAME TO productVariantEntity_pkey;

-- UUID ids and `...Id` column names like the other services (the TEXT ids came from the MongoDB original).
-- Fails loudly if a stored id is not a UUID (only possible with hand-made data); nothing is changed then.
DO $$
DECLARE
    uuid_pattern CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
    IF EXISTS (SELECT 1 FROM PaymentInformationEntity WHERE id !~ uuid_pattern OR userId !~ uuid_pattern) THEN
        RAISE EXCEPTION 'PaymentInformationEntity contains ids that are not UUIDs; fix them before migrating';
    END IF;
    IF EXISTS (SELECT 1 FROM PaymentEntity WHERE id !~ uuid_pattern OR paymentInformation !~ uuid_pattern) THEN
        RAISE EXCEPTION 'PaymentEntity contains ids that are not UUIDs; fix them before migrating';
    END IF;
    IF EXISTS (SELECT 1 FROM OpenOrderEntity WHERE paymentId !~ uuid_pattern OR orderId !~ uuid_pattern) THEN
        RAISE EXCEPTION 'OpenOrderEntity contains ids that are not UUIDs; fix them before migrating';
    END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- seq reproduced MongoDB's natural order; nothing reads it
ALTER TABLE PaymentInformationEntity
    DROP COLUMN seq,
    ALTER COLUMN id TYPE UUID USING id::uuid,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4(),
    ALTER COLUMN userId TYPE UUID USING userId::uuid,
    ALTER COLUMN userId SET NOT NULL;

ALTER TABLE PaymentEntity
    DROP COLUMN seq,
    ALTER COLUMN id TYPE UUID USING id::uuid,
    ALTER COLUMN id SET DEFAULT uuid_generate_v4(),
    ALTER COLUMN paymentInformation TYPE UUID USING paymentInformation::uuid,
    ALTER COLUMN numberOfRetries TYPE INTEGER USING COALESCE(numberOfRetries, 0)::integer,
    ALTER COLUMN numberOfRetries SET NOT NULL;
ALTER TABLE PaymentEntity RENAME COLUMN paymentInformation TO paymentInformationId;
ALTER INDEX paymentEntity_paymentInformation RENAME TO paymentEntity_paymentInformationId;

-- one open order per payment: the payment id is the key (the surrogate BIGINT id is not used)
ALTER TABLE OpenOrderEntity
    DROP COLUMN id,
    ALTER COLUMN paymentId TYPE UUID USING paymentId::uuid,
    ALTER COLUMN orderId TYPE UUID USING orderId::uuid,
    ADD PRIMARY KEY (paymentId);
DROP INDEX openOrderEntity_paymentId;

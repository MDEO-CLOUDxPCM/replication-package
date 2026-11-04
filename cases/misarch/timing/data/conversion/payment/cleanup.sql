-- unify 9e4cd77's final schema -> V1_1__create_relations.sql
ALTER TABLE OpenOrderEntity ADD CONSTRAINT openOrderEntity_orderId_key UNIQUE USING INDEX openOrderEntity_orderId;
-- totalAmount: whole amounts in the smallest currency unit, as every other money column (BIGINT); fails on a fraction
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM PaymentEntity WHERE totalAmount <> trunc(totalAmount)) THEN
        RAISE EXCEPTION 'PaymentEntity.totalAmount has fractional values; cannot convert to BIGINT';
    END IF;
END $$;
ALTER TABLE PaymentEntity ALTER COLUMN totalAmount TYPE BIGINT USING totalAmount::bigint;
-- the method details and the open orders as JSONB (documents read as a whole); the order column named like the others
ALTER TABLE PaymentInformationEntity ALTER COLUMN publicMethodDetails TYPE JSONB USING publicMethodDetails::jsonb;
ALTER TABLE PaymentInformationEntity ALTER COLUMN secretMethodDetails TYPE JSONB USING secretMethodDetails::jsonb;
ALTER TABLE OpenOrderEntity ALTER COLUMN orderJson TYPE JSONB USING orderJson::jsonb;
ALTER TABLE OpenOrderEntity RENAME COLUMN orderJson TO orderData;

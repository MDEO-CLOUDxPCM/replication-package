-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255); the name rule as a CHECK
-- constraint instead of a trigger (fails on a row with only one of the two names)
ALTER TABLE AddressEntity
    ALTER COLUMN street1 TYPE TEXT, ALTER COLUMN street2 TYPE TEXT, ALTER COLUMN city TYPE TEXT,
    ALTER COLUMN postalCode TYPE TEXT, ALTER COLUMN country TYPE TEXT, ALTER COLUMN companyName TYPE TEXT,
    ALTER COLUMN firstName TYPE TEXT, ALTER COLUMN lastName TYPE TEXT;
DROP TRIGGER enforce_names_null_or_not_null ON AddressEntity;
DROP FUNCTION check_names_null_or_not_null();
ALTER TABLE AddressEntity ADD CONSTRAINT addressEntity_firstName_lastName_check CHECK ((firstName IS NULL) = (lastName IS NULL));

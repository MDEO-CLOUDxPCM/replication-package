-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255)
ALTER TABLE AddressEntity
    ALTER COLUMN street1 TYPE TEXT, ALTER COLUMN street2 TYPE TEXT, ALTER COLUMN city TYPE TEXT,
    ALTER COLUMN postalCode TYPE TEXT, ALTER COLUMN country TYPE TEXT, ALTER COLUMN companyName TYPE TEXT;
ALTER TABLE ShipmentMethodEntity
    ALTER COLUMN name TYPE TEXT, ALTER COLUMN description TYPE TEXT, ALTER COLUMN externalReference TYPE TEXT;
ALTER TABLE ShipmentEntity ALTER COLUMN status TYPE TEXT;

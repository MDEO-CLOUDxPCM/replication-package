-- unify 9e4cd77's final schema -> V1_1__create_relations.sql: the vendor address's seq becomes version (the current
-- vendor address has the highest version) and its address lines NOT NULL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
ALTER TABLE VendorAddressEntity RENAME COLUMN seq TO version;
ALTER SEQUENCE vendor_address_seq_seq RENAME TO vendorAddressEntity_version_seq;
-- a vendor address with only an id (event-created rows of the original) was never usable: it goes
DELETE FROM VendorAddressEntity
    WHERE street1 IS NULL OR street2 IS NULL OR city IS NULL OR postalCode IS NULL OR country IS NULL;
ALTER TABLE VendorAddressEntity
    ALTER COLUMN street1 SET NOT NULL, ALTER COLUMN street2 SET NOT NULL, ALTER COLUMN city SET NOT NULL,
    ALTER COLUMN postalCode SET NOT NULL, ALTER COLUMN country SET NOT NULL;
ALTER TABLE InvoiceEntity ADD CONSTRAINT invoiceEntity_orderId_key UNIQUE USING INDEX invoiceEntity_orderId;

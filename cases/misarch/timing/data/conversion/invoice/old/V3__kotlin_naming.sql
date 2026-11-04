-- Table and column names of the Kotlin services (MisarchNamingStrategy: table = entity class, column = property name,
-- both unquoted); all rows are kept.

-- invoices: the address snapshots are part of `content`; of the embedded address documents only their ids are used
ALTER TABLE invoices RENAME TO InvoiceEntity;
ALTER TABLE InvoiceEntity RENAME COLUMN order_id TO orderId;
ALTER TABLE InvoiceEntity RENAME COLUMN issued_at TO issuedAt;
ALTER TABLE InvoiceEntity RENAME COLUMN vat_number TO vatNumber;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM InvoiceEntity
        WHERE COALESCE(user_address ->> '_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR COALESCE(vendor_address ->> '_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
        RAISE EXCEPTION 'invoices with an address snapshot without a UUID _id; migrate them by hand';
    END IF;
END
$$;
ALTER TABLE InvoiceEntity ADD COLUMN userAddressId uuid, ADD COLUMN vendorAddressId uuid;
UPDATE InvoiceEntity SET userAddressId = (user_address ->> '_id')::uuid, vendorAddressId = (vendor_address ->> '_id')::uuid;
ALTER TABLE InvoiceEntity ALTER COLUMN userAddressId SET NOT NULL, ALTER COLUMN vendorAddressId SET NOT NULL;
-- seq (Mongo's natural order) is not needed: there is one invoice per order (drops invoices_order_id_idx)
ALTER TABLE InvoiceEntity DROP COLUMN user_address, DROP COLUMN vendor_address, DROP COLUMN seq;
ALTER TABLE InvoiceEntity RENAME CONSTRAINT invoices_pkey TO invoiceEntity_pkey;
ALTER INDEX invoices_order_id_uk RENAME TO invoiceEntity_orderId;

-- vendor addresses: seq keeps the order of arrival (the first complete vendor address is used)
ALTER TABLE vendor_address RENAME TO VendorAddressEntity;
ALTER TABLE VendorAddressEntity RENAME COLUMN postal_code TO postalCode;
ALTER TABLE VendorAddressEntity RENAME COLUMN company_name TO companyName;
ALTER TABLE VendorAddressEntity RENAME CONSTRAINT vendor_address_pkey TO vendorAddressEntity_pkey;

-- users: `addresses` (always []) and `user_addresses` (never written since the fix) are replaced by UserAddressEntity
ALTER TABLE users RENAME TO UserEntity;
ALTER TABLE UserEntity RENAME COLUMN first_name TO firstName;
ALTER TABLE UserEntity RENAME COLUMN last_name TO lastName;
ALTER TABLE UserEntity DROP COLUMN addresses, DROP COLUMN user_addresses, DROP COLUMN seq;
ALTER TABLE UserEntity RENAME CONSTRAINT users_pkey TO userEntity_pkey;

ALTER TABLE user_address RENAME TO UserAddressEntity;
ALTER TABLE UserAddressEntity RENAME COLUMN user_id TO userId;
ALTER TABLE UserAddressEntity RENAME COLUMN postal_code TO postalCode;
ALTER TABLE UserAddressEntity RENAME COLUMN company_name TO companyName;
ALTER TABLE UserAddressEntity RENAME COLUMN first_name TO firstName;
ALTER TABLE UserAddressEntity RENAME COLUMN last_name TO lastName;
ALTER TABLE UserAddressEntity RENAME COLUMN archived TO isArchived;
ALTER TABLE UserAddressEntity RENAME CONSTRAINT user_address_pkey TO userAddressEntity_pkey;

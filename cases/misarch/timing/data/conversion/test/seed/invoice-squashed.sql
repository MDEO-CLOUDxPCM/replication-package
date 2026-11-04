INSERT INTO VendorAddressEntity (id, street1, street2, city, postalCode, country, companyName)
    VALUES ('90000000-0000-4000-8000-0000000000b1', 'Old St', '1', 'X', '1', 'DE', 'Old'),
           ('90000000-0000-4000-8000-0000000000b2', 'New St', '2', 'Y', '2', 'DE', 'New');
INSERT INTO InvoiceEntity (id, orderId, issuedAt, content, userAddressId, vendorAddressId)
    VALUES (gen_random_uuid(), gen_random_uuid(), now(), 'c', gen_random_uuid(), '90000000-0000-4000-8000-0000000000b1');

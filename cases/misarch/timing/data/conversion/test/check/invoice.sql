DO $$ BEGIN
    ASSERT (SELECT count(*) FROM InvoiceEntity WHERE userAddressId = '10000000-0000-4000-8000-0000000000a1'
            AND vendorAddressId = '10000000-0000-4000-8000-0000000000b1') = 3, 'invoice address ids';
    ASSERT (SELECT vatNumber FROM InvoiceEntity WHERE orderId = '10000000-0000-4000-8000-00000000d001') = 'DE123', 'vat';
    ASSERT (SELECT firstName || ' ' || lastName FROM UserEntity) = 'Ada Lovelace', 'user';
    ASSERT (SELECT isArchived FROM UserAddressEntity) = false, 'address';
    ASSERT (SELECT count(*) FROM VendorAddressEntity) = 1, 'the id-only vendor address is gone';
    ASSERT (SELECT id FROM VendorAddressEntity ORDER BY version DESC LIMIT 1) = '10000000-0000-4000-8000-0000000000b1', 'current';
    INSERT INTO VendorAddressEntity (id, street1, street2, city, postalCode, country)
        VALUES ('10000000-0000-4000-8000-0000000000b2', 'New St', '2', 'Y', '2', 'DE');
    ASSERT (SELECT id FROM VendorAddressEntity ORDER BY version DESC LIMIT 1) = '10000000-0000-4000-8000-0000000000b2', 'version continues';
    BEGIN
        INSERT INTO InvoiceEntity (id, orderId, issuedAt, content, userAddressId, vendorAddressId)
            VALUES (gen_random_uuid(), '10000000-0000-4000-8000-00000000d001', now(), 'x', gen_random_uuid(), gen_random_uuid());
        RAISE EXCEPTION 'second invoice of an order accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

DO $$ BEGIN
    ASSERT (SELECT id FROM VendorAddressEntity ORDER BY version DESC LIMIT 1) = '90000000-0000-4000-8000-0000000000b2', 'current vendor address';
    ASSERT (SELECT count(*) FROM InvoiceEntity) = 1, 'invoice';
END $$;

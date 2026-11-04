DO $$ BEGIN
    ASSERT (SELECT count(*) FROM ShipmentToOrderItemEntity) = 1, 'deduplicated link';
    ASSERT (SELECT id FROM AddressEntity WHERE userId IS NULL ORDER BY version DESC LIMIT 1) = '85000000-0000-4000-8000-0000000000a1', 'vendor';
    ASSERT (SELECT baseFees FROM ShipmentMethodEntity) = 499, 'method';
END $$;

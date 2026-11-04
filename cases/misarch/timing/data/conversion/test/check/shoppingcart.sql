DO $$ BEGIN
    ASSERT (SELECT sum(count) FROM ShoppingCartItemEntity WHERE userId = '40000000-0000-4000-8000-000000000001') = 3, 'items';
    INSERT INTO ShoppingCartItemEntity (userId, count, addedAt, productVariantId)
        VALUES ('40000000-0000-4000-8000-000000000001', 1, now(), gen_random_uuid());
    ASSERT (SELECT count(*) FROM ShoppingCartItemEntity) = 3, 'generated id';
END $$;

DO $$ BEGIN
    ASSERT (SELECT count(*) FROM WishlistToProductVariantEntity WHERE wishlistId = '50000000-0000-4000-8000-0000000000c1') = 2, 'links';
    INSERT INTO WishlistEntity (userId, name, createdAt, lastUpdatedAt) VALUES (gen_random_uuid(), 'v', now(), now());
    ASSERT (SELECT count(*) FROM WishlistEntity) = 2, 'generated id';
END $$;

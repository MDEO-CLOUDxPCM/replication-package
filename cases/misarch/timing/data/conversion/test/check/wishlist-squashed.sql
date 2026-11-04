DO $$ BEGIN
    ASSERT (SELECT name FROM WishlistEntity) = 'birthday', 'wishlist';
    ASSERT (SELECT data_type FROM information_schema.columns WHERE table_name = 'wishlistentity' AND column_name = 'name') = 'text', 'text';
END $$;

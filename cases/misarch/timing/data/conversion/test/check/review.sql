DO $$ BEGIN
    ASSERT (SELECT string_agg(rating || ':' || stars, ',' ORDER BY stars) FROM ReviewEntity)
           = 'ONE_STARS:1,FOUR_STARS:4,FIVE_STARS:5', 'ratings and stars';
    ASSERT (SELECT count(*) FROM ReviewEntity WHERE productId = '30000000-0000-4000-8000-0000000000b1' AND isVisible) = 2, 'visible';
    ASSERT (SELECT productId FROM ProductVariantEntity) = '30000000-0000-4000-8000-0000000000b1', 'variant';
    INSERT INTO ReviewEntity (userId, productVariantId, productId, body, rating, createdAt, lastUpdatedAt, isVisible)
        VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'b', 'TWO_STARS', now(), now(), true);
    BEGIN
        INSERT INTO ReviewEntity (userId, productVariantId, productId, body, rating, createdAt, lastUpdatedAt, isVisible)
            VALUES ('30000000-0000-4000-8000-00000000e001', '30000000-0000-4000-8000-0000000000c1', gen_random_uuid(), 'b',
                    'TWO_STARS', now(), now(), true);
        RAISE EXCEPTION 'second review accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

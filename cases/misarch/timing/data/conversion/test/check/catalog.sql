DO $$ BEGIN
    ASSERT (SELECT count(*) FROM ProductToCategoryEntity) = 1 AND (SELECT count(*) FROM ProductVariantVersionToMediaEntity) = 1, 'links';
    ASSERT (SELECT stringValue FROM CategoryCharacteristicValueEntity) = 'red', 'value';
    ASSERT (SELECT retailPrice || '/' || weight || '/' || canBeReturnedForDays FROM ProductVariantVersionEntity) = '4999/0.5/30', 'version';
    ASSERT (SELECT currentVersion FROM ProductVariantEntity) = '81000000-0000-4000-8000-0000000000b3', 'current version';
    BEGIN
        UPDATE ProductEntity SET defaultVariantId = gen_random_uuid();
        RAISE EXCEPTION 'unknown default variant accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;

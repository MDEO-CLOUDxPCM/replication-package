DO $$ BEGIN
    ASSERT (SELECT v.rate FROM TaxRateEntity r JOIN TaxRateVersionEntity v ON v.id = r.currentVersionId) = 0.19, 'current version';
    BEGIN
        UPDATE TaxRateEntity SET currentVersionId = gen_random_uuid();
        RAISE EXCEPTION 'unknown version accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;

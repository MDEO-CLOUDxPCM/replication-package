DO $$ BEGIN
    ASSERT (SELECT id FROM AddressEntity WHERE userId IS NULL ORDER BY version DESC LIMIT 1) = '80000000-0000-4000-8000-0000000000a2', 'vendor';
    ASSERT (SELECT firstName || lastName FROM AddressEntity WHERE id = '80000000-0000-4000-8000-0000000000a1') = 'AdaLovelace', 'names';
    INSERT INTO AddressEntity (street1, city, postalCode, country) VALUES ('s', 'c', 'p', 'DE');
    ASSERT (SELECT max(version) FROM AddressEntity) = 3, 'version continues';
    BEGIN
        INSERT INTO AddressEntity (street1, city, postalCode, country, firstName) VALUES ('s', 'c', 'p', 'DE', 'Ada');
        RAISE EXCEPTION 'one name accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

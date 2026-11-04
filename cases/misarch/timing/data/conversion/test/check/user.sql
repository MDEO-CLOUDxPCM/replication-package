DO $$ BEGIN
    ASSERT (SELECT username || ' ' || firstName || ' ' || lastName || ' ' || gender FROM UserEntity) = 'ada Ada Lovelace FEMALE', 'user';
END $$;

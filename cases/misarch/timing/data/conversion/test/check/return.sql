DO $$ BEGIN
    ASSERT (SELECT count(*) FROM OrderItemEntity WHERE returnedWithId = '84000000-0000-4000-8000-0000000000f1') = 1, 'returned item';
    ASSERT (SELECT reason FROM ReturnEntity) = 'too small', 'return';
    ASSERT (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = 'public') = 0, 'no triggers';
END $$;

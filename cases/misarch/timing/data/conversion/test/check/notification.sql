DO $$ BEGIN
    ASSERT (SELECT count(*) FROM NotificationEntity WHERE userId = '83000000-0000-4000-8000-000000000001' AND title LIKE 'title %') = 3, 'notifications';
END $$;

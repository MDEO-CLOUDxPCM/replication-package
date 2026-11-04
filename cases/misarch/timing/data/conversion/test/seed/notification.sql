INSERT INTO UserEntity (id) VALUES ('83000000-0000-4000-8000-000000000001');
INSERT INTO NotificationEntity (dateSent, title, body, userId) SELECT now(), 'title ' || i, 'body', '83000000-0000-4000-8000-000000000001' FROM generate_series(1, 3) i;

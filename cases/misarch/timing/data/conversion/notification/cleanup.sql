-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255)
ALTER TABLE NotificationEntity ALTER COLUMN title TYPE TEXT;

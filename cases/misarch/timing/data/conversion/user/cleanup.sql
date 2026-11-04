-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255)
ALTER TABLE UserEntity
    ALTER COLUMN username TYPE TEXT, ALTER COLUMN firstName TYPE TEXT, ALTER COLUMN gender TYPE TEXT,
    ALTER COLUMN lastName TYPE TEXT;

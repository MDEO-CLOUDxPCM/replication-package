-- unify 9e4cd77's final schema -> V1_1__create_relations.sql
ALTER INDEX WishlistEntity_userId_idx RENAME TO wishlistEntity_userId;
ALTER TABLE WishlistEntity ALTER COLUMN name TYPE TEXT;

-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255); the default name for the
-- current version's foreign key
ALTER TABLE TaxRateEntity ALTER COLUMN name TYPE TEXT, ALTER COLUMN description TYPE TEXT;
ALTER TABLE TaxRateEntity RENAME CONSTRAINT fk_tax_rate_version TO taxRateEntity_currentVersionId_fkey;

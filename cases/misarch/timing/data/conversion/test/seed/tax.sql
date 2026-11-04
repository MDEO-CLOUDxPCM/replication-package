INSERT INTO TaxRateEntity (id, name, description) VALUES ('86000000-0000-4000-8000-0000000000a1', 'VAT', 'standard');
INSERT INTO TaxRateVersionEntity (id, rate, createdAt, version, taxRateId)
    VALUES ('86000000-0000-4000-8000-0000000000b1', 0.19, now(), 1, '86000000-0000-4000-8000-0000000000a1');
UPDATE TaxRateEntity SET currentVersionId = '86000000-0000-4000-8000-0000000000b1';

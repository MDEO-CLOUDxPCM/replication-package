INSERT INTO ProductVariantPartialEntity (id) VALUES ('60000000-0000-4000-8000-0000000000b1');
INSERT INTO ProductItemEntity (id, productVariant, inventoryStatus, orderId)
    SELECT '60000000-0000-4000-8000-00000000c' || lpad(i::text, 3, '0'), '60000000-0000-4000-8000-0000000000b1',
           CASE WHEN i % 3 = 0 THEN 'RESERVED' ELSE 'IN_STORAGE' END,
           CASE WHEN i % 3 = 0 THEN '60000000-0000-4000-8000-0000000000d1' END
    FROM generate_series(1, 50) i;
-- a "phantom" item without product variant (the conversion's V3 deletes it)
INSERT INTO ProductItemEntity (id, productVariant, inventoryStatus) VALUES ('60000000-0000-4000-8000-0000000000e1', NULL, 'IN_STORAGE');
-- gaps in seq, as deletes leave them
DELETE FROM ProductItemEntity WHERE id = '60000000-0000-4000-8000-00000000c010';

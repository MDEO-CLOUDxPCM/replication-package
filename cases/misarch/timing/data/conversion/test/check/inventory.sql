DO $$ BEGIN
    ASSERT (SELECT count(*) FROM ProductItemEntity) = 49, 'items (phantom gone)';
    ASSERT (SELECT string_agg(right(id::text, 3), ',' ORDER BY insertionOrder) FROM (SELECT id, insertionOrder FROM ProductItemEntity
            WHERE inventoryStatus = 'IN_STORAGE' ORDER BY insertionOrder LIMIT 4) x) = '001,002,004,005', 'insertion order kept';
    ASSERT (SELECT count(*) FROM ProductItemEntity WHERE orderId = '60000000-0000-4000-8000-0000000000d1') = 16, 'reserved';
    ASSERT (SELECT id FROM ProductVariantEntity) = '60000000-0000-4000-8000-0000000000b1', 'variant';
    INSERT INTO ProductItemEntity (productVariantId, inventoryStatus) VALUES ('60000000-0000-4000-8000-0000000000b1', 'IN_STORAGE');
    ASSERT (SELECT insertionOrder FROM ProductItemEntity ORDER BY insertionOrder DESC LIMIT 1) = 51, 'sequence continues after the largest';
END $$;

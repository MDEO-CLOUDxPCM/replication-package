-- Reservation (ProductItemStore.reserveAvailable): WHERE productVariant = ? AND inventoryStatus = 'IN_STORAGE'
-- ORDER BY seq LIMIT n. With only (productVariant, inventoryStatus) Postgres walked the seq index and filtered: the
-- first free item of a variant moves further along seq with every order (514k items: 417k rows filtered, 100 ms per
-- reservation; inventory-db CPU per placed order grew from 5 ms at 3k orders to 60 ms at 200k). This index returns
-- the free items of the variant in seq order directly (2 ms) and covers the old index's prefix.
CREATE INDEX productItemEntity_variant_status_seq ON ProductItemEntity (productVariant, inventoryStatus, seq);
DROP INDEX productItemEntity_variant_status;

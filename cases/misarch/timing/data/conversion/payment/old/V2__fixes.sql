-- Defect fixes (docs/fixes/payment.md).

-- P2: numberOfRetries is stored (0 for new payments, incremented per credit-card retry); old rows count as 0.
UPDATE PaymentEntity SET numberOfRetries = 0 WHERE numberOfRetries IS NULL;
ALTER TABLE PaymentEntity ALTER COLUMN numberOfRetries SET DEFAULT 0;

-- P4: one payment per order: the order id of the open order is unique (redelivered validation-succeeded events
-- are skipped). Orders without an id (NULL) are not deduplicated.
ALTER TABLE OpenOrderEntity ADD COLUMN orderId TEXT COLLATE "C";
CREATE UNIQUE INDEX openOrderEntity_orderId ON OpenOrderEntity (orderId);

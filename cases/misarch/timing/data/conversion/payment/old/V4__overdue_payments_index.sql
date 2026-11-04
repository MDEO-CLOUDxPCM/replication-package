-- PaymentService.failOverdueInvoicePayments / failOverduePrepaymentPayments (every 15 minutes): PENDING payments
-- created before a point in time, joined with their payment information by primary key. (status, createdAt) finds
-- them with one range scan instead of reading every payment of the status; it covers the old status index.
CREATE INDEX paymentEntity_status_createdAt ON PaymentEntity (status, createdAt);
DROP INDEX paymentEntity_status;

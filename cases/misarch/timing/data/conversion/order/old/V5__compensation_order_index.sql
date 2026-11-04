-- Index for the compensation of a failed shipment (OrderCompensationToOrderItemRepository.findByOrderId joins the
-- compensations of one order); before, every shipment/shipment/creation-failed event scanned all compensations.
CREATE INDEX orderCompensationEntity_orderId ON OrderCompensationEntity (orderId);

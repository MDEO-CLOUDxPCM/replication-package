-- Lookups without an index scanned whole tables, so their cost grew with every order (267k shipments: 11 ms for the
-- per-order existsByOrderId idempotency check, 53 ms for the order items of a shipment; shipment-db CPU per placed
-- order grew 3.5x between 40k and 200k orders).
CREATE INDEX shipmentEntity_orderId ON ShipmentEntity (orderId);
CREATE INDEX shipmentEntity_returnId ON ShipmentEntity (returnId);
CREATE INDEX shipmentToOrderItemEntity_shipmentId ON ShipmentToOrderItemEntity (shipmentId);

-- Link table: the natural key (shipment, order item) becomes the primary key instead of a technical id that nothing
-- read. The table had no unique constraint, so duplicate pairs are removed first (one row per pair is kept; the
-- service never wrote a pair twice for one shipment). The shipmentId index of V1_6 is covered by the primary key
-- (it leads with shipmentId) and goes.
DELETE FROM ShipmentToOrderItemEntity a
    USING ShipmentToOrderItemEntity b
    WHERE a.shipmentId = b.shipmentId AND a.orderItemId = b.orderItemId AND a.id > b.id;
ALTER TABLE ShipmentToOrderItemEntity DROP COLUMN id;
ALTER TABLE ShipmentToOrderItemEntity ADD PRIMARY KEY (shipmentId, orderItemId);
DROP INDEX shipmentToOrderItemEntity_shipmentId;

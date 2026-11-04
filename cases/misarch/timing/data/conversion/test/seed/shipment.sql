INSERT INTO AddressEntity (id, userId, street1, street2, city, postalCode, country, companyName)
    VALUES ('85000000-0000-4000-8000-0000000000a1', NULL, 'Main St', '1', 'X', '1', 'DE', 'MiSArch'),
           ('85000000-0000-4000-8000-0000000000a2', gen_random_uuid(), 's', '2', 'c', 'p', 'DE', NULL);
INSERT INTO ShipmentMethodEntity (id, name, description, externalReference, baseFees, feesPerItem, feesPerKg)
    VALUES ('85000000-0000-4000-8000-0000000000c1', 'Standard', 'd', 'std', 499, 10, 20);
INSERT INTO ShipmentEntity (id, status, shipmentMethodId, shipmentAddressId, orderId)
    VALUES ('85000000-0000-4000-8000-0000000000d1', 'DELIVERED', '85000000-0000-4000-8000-0000000000c1', '85000000-0000-4000-8000-0000000000a2', gen_random_uuid());
INSERT INTO OrderItemEntity (id, sentWithId, quantity, productVariantVersionId)
    VALUES ('85000000-0000-4000-8000-0000000000e1', '85000000-0000-4000-8000-0000000000d1', 2, gen_random_uuid());
-- a duplicate link pair (the conversion's V2 keeps one)
INSERT INTO ShipmentToOrderItemEntity (shipmentId, orderItemId)
    VALUES ('85000000-0000-4000-8000-0000000000d1', '85000000-0000-4000-8000-0000000000e1'),
           ('85000000-0000-4000-8000-0000000000d1', '85000000-0000-4000-8000-0000000000e1');

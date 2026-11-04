DO $$ BEGIN
    ASSERT (SELECT count(*) FROM UserAddressEntity WHERE userId = '20000000-0000-4000-8000-000000000001') = 2, 'addresses';
    ASSERT (SELECT compensatableOrderAmount FROM OrderEntity WHERE id = '20000000-0000-4000-8000-000000000d01') = 3998, 'order';
    ASSERT (SELECT count || '/' || position || '/' || taxRateVersionRate FROM OrderItemEntity) = '2/0/0.19', 'item';
    ASSERT (SELECT discount FROM OrderItemToDiscountEntity) = 0.1, 'discount';
    ASSERT (SELECT orderItemId FROM OrderCompensationToOrderItemEntity) = '20000000-0000-4000-8000-000000000e01', 'compensation';
    ASSERT (SELECT currentVersionPrice FROM ProductVariantEntity) = 1999, 'variant';
    INSERT INTO OrderEntity (userId, createdAt, orderStatus, shipmentAddressId, invoiceAddressId, compensatableOrderAmount,
        paymentInformationId) VALUES (gen_random_uuid(), now(), 'PENDING', gen_random_uuid(), gen_random_uuid(), 0, gen_random_uuid());
END $$;

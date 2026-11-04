DO $$ BEGIN
    ASSERT (SELECT publicMethodDetails FROM PaymentInformationEntity WHERE id = '70000000-0000-4000-8000-0000000000a1')
           = '{"cardNumber":"****1111", "cardHolder":"A"}'::jsonb, 'method details kept';
    ASSERT (SELECT string_agg(numberOfRetries::text, ',' ORDER BY totalAmount) FROM PaymentEntity) = '2,0', 'retries';
    ASSERT (SELECT paymentInformationId FROM PaymentEntity WHERE id = '70000000-0000-4000-8000-0000000000b1')
           = '70000000-0000-4000-8000-0000000000a1', 'information id';
    ASSERT (SELECT orderData FROM OpenOrderEntity WHERE paymentId = '70000000-0000-4000-8000-0000000000b1')
           = '{"id":"70000000-0000-4000-8000-0000000000d1","b":1,"a":2}'::jsonb, 'order data';
    BEGIN
        INSERT INTO OpenOrderEntity (paymentId, orderData, orderId) VALUES (gen_random_uuid(), '{}', '70000000-0000-4000-8000-0000000000d1');
        RAISE EXCEPTION 'second open order accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;

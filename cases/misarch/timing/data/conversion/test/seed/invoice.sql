INSERT INTO users (id, first_name, last_name) VALUES ('10000000-0000-4000-8000-000000000001', 'Ada', 'Lovelace');
INSERT INTO user_address (id, user_id, street1, street2, city, postal_code, country, first_name, last_name)
    VALUES ('10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 's1', 's2', 'c', 'p', 'DE', 'Ada', 'Lovelace');
INSERT INTO vendor_address (id) VALUES ('10000000-0000-4000-8000-0000000000b0');
INSERT INTO vendor_address (id, street1, street2, city, postal_code, country, company_name)
    VALUES ('10000000-0000-4000-8000-0000000000b1', 'Main St', '', 'X', '1', 'DE', 'MiSArch');
INSERT INTO invoices (id, order_id, issued_at, content, user_address, vendor_address, vat_number)
    SELECT ('10000000-0000-4000-8000-00000000c00' || i)::uuid, ('10000000-0000-4000-8000-00000000d00' || i)::uuid, now(),
           'invoice ' || i, jsonb_build_object('_id', '10000000-0000-4000-8000-0000000000a1', 'street1', 's1'),
           jsonb_build_object('_id', '10000000-0000-4000-8000-0000000000b1'), CASE WHEN i = 1 THEN 'DE123' END
    FROM generate_series(1, 3) i;

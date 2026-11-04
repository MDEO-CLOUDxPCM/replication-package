INSERT INTO users (id) VALUES ('30000000-0000-4000-8000-000000000001');
INSERT INTO products (id) VALUES ('30000000-0000-4000-8000-0000000000b1');
INSERT INTO product_variants (id, product_id) VALUES ('30000000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-0000000000b1');
INSERT INTO reviews (id, user_id, product_variant_id, product_variant_product_id, body, rating, created_at, last_updated_at, is_visible)
    SELECT ('30000000-0000-4000-8000-00000000d00' || i)::uuid, ('30000000-0000-4000-8000-00000000e00' || i)::uuid,
           '30000000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-0000000000b1', 'b' || i,
           (ARRAY['OneStars', 'FourStars', 'FiveStars'])[i], now(), now(), i <> 2
    FROM generate_series(1, 3) i;

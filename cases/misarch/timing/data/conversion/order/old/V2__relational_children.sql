-- Relational port of the order service's id arrays (docs/specs/order.md §9, docs/PORTING.md §6 "Former MongoDB
-- services"): each array becomes a child table that is read and written row by row, like the link tables of the
-- Kotlin services (e.g. shipment's ShipmentToOrderItemEntity).

-- users.user_address_ids -> user_addresses (one row per address of a user; createOrder looks up the shipment and
-- the invoice address of the user instead of reading all address ids of the user)
CREATE TABLE user_addresses (
    user_id uuid NOT NULL REFERENCES users (id),
    id      uuid NOT NULL,
    PRIMARY KEY (user_id, id)
);
INSERT INTO user_addresses (user_id, id)
SELECT DISTINCT u.id, a.id FROM users u, unnest(u.user_address_ids) AS a(id);
ALTER TABLE users DROP COLUMN user_address_ids;

-- order_compensations.order_item_ids -> order_compensation_items (position = index in the former array)
CREATE TABLE order_compensation_items (
    order_compensation_id uuid NOT NULL REFERENCES order_compensations (id),
    order_item_id         uuid NOT NULL,
    position              int  NOT NULL,
    PRIMARY KEY (order_compensation_id, order_item_id)
);
INSERT INTO order_compensation_items (order_compensation_id, order_item_id, position)
SELECT c.id, i.item_id, i.ordinality - 1
FROM order_compensations c, unnest(c.order_item_ids) WITH ORDINALITY AS i(item_id, ordinality)
ON CONFLICT DO NOTHING;
ALTER TABLE order_compensations DROP COLUMN order_item_ids;

-- FIXED (docs/fixes/invoice.md): user addresses are kept in their own table, independent of the user row and of the
-- order in which user and address events arrive (the original pushed them onto `user_addresses` of an existing user
-- only, while the invoice lookup read `addresses`, D3). `first_name`/`last_name` are the addressee's name of the event.
CREATE TABLE user_address (
    id           uuid PRIMARY KEY,
    user_id      uuid    NOT NULL,
    street1      text    NOT NULL,
    street2      text    NOT NULL,
    city         text    NOT NULL,
    postal_code  text    NOT NULL,
    country      text    NOT NULL,
    company_name text,
    first_name   text,
    last_name    text,
    archived     boolean NOT NULL DEFAULT false
);

-- FIXED: one invoice per order (a redelivered event created a second invoice)
CREATE UNIQUE INDEX invoices_order_id_uk ON invoices (order_id);

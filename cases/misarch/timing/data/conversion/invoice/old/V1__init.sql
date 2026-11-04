-- Port of the MongoDB collections of the original invoice service (database `invoice-database`).
-- See docs/specs/invoice.md §6. `seq` columns reproduce Mongo's natural (insertion) order for find_one.

-- invoices {_id, order_id, issued_at, content, user_address{...}, vendor_address{...}, vat_number}
CREATE TABLE invoices (
    id             uuid PRIMARY KEY,
    order_id       uuid        NOT NULL,
    issued_at      timestamptz NOT NULL,
    content        text        NOT NULL,
    user_address   jsonb       NOT NULL,
    vendor_address jsonb       NOT NULL,
    vat_number     text,
    seq            bigserial
);
CREATE INDEX invoices_order_id_idx ON invoices (order_id, seq);

-- vendor_address: the original's upsert only writes `_id`, so event-created rows have no other fields
CREATE TABLE vendor_address (
    id           uuid PRIMARY KEY,
    street1      text,
    street2      text,
    city         text,
    postal_code  text,
    country      text,
    company_name text,
    seq          bigserial
);

-- Mongo collection `user` (renamed: `user` is reserved in Postgres) {_id, first_name, last_name, addresses[], user_addresses[]}
-- `addresses` is written only on user creation (always []); address events push to `user_addresses` (defect D3).
CREATE TABLE users (
    id             uuid PRIMARY KEY,
    first_name     text  NOT NULL,
    last_name      text  NOT NULL,
    addresses      jsonb NOT NULL DEFAULT '[]'::jsonb,
    user_addresses jsonb,
    seq            bigserial
);

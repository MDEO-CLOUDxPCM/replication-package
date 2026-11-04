-- The database generates the ids of new shopping cart items (like the ids of the other services' tables), so the
-- service saves a new ShoppingCartItemEntity with a null id. Existing rows are unchanged.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
ALTER TABLE ShoppingCartItemEntity ALTER COLUMN id SET DEFAULT uuid_generate_v4();

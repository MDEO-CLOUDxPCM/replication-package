-- The database generates the ids of new wishlists (like the ids of the other services' tables), so the service saves
-- a new WishlistEntity with a null id. Existing rows are unchanged.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
ALTER TABLE WishlistEntity ALTER COLUMN id SET DEFAULT uuid_generate_v4();

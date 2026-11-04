-- User.addresses (WHERE userId = ? AND archivedAt IS NULL, COUNT and the page ORDER BY id) scanned the whole table:
-- 52k addresses, 2 ms per statement. (userId, id) serves the archived/unarchived filters and the id order alike.
CREATE INDEX addressEntity_userId_id ON AddressEntity (userId, id);

-- User.notifications filtered by userId without an index scanned the whole table for each of its three statements
-- (COUNT, the hasNextPage probe SELECT 1 ... OFFSET, the page ORDER BY id LIMIT): 200k notifications, ~3,700 blocks
-- and 6.8 ms per statement. (userId, id) answers all three and returns the page in id order.
CREATE INDEX notificationEntity_userId_id ON NotificationEntity (userId, id);

-- Lookups by foreign key without an index scanned whole tables, so their cost grew with every order:
-- * Return.returnItems (OrderItemEntity WHERE returnedWithId = ?): 121k order items;
-- * User.returns and the returns connection of a buyer (OrderEntity WHERE userId = ?, joined with ReturnEntity on
--   orderId): 97k orders.
CREATE INDEX orderItemEntity_returnedWithId ON OrderItemEntity (returnedWithId);
CREATE INDEX orderEntity_userId ON OrderEntity (userId);
CREATE INDEX returnEntity_orderId ON ReturnEntity (orderId);

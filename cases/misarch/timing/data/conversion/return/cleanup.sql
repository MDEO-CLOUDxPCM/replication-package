-- unify 786f33c's final schema -> V1_1__create_relations.sql: TEXT instead of VARCHAR(255); without the triggers on
-- OrderItemEntity (ReturnService checks the same rules: same order, delivered, within the return period)
ALTER TABLE ReturnEntity ALTER COLUMN reason TYPE TEXT;
DROP TRIGGER before_update_orderitem_check_return_order_match ON OrderItemEntity;
DROP TRIGGER check_return_trigger ON OrderItemEntity;
DROP FUNCTION check_return_order_match();
DROP FUNCTION check_return_within_period();

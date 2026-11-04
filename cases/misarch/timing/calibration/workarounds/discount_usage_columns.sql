-- Workaround for a MiSArch defect (discount image of 2025-06): DiscountUsageRepository.upsertDiscountUsage is a native
-- query on columns discount_id/user_id, while the Flyway migration created discountId/userId (-> discountid/userid).
-- Every order with an applicable discount then fails in discount's reservation-succeeded handler (HTTP 500, redelivered
-- forever) and the saga stops. Schema-only fix: add the snake_case columns, a unique index for ON CONFLICT, and a
-- BEFORE INSERT trigger (fires before check_discount_usages_trigger, alphabetical) that fills the real columns.
ALTER TABLE DiscountUsageEntity ADD COLUMN IF NOT EXISTS discount_id UUID;
ALTER TABLE DiscountUsageEntity ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS discountusage_snake_uk ON DiscountUsageEntity (discount_id, user_id);
CREATE OR REPLACE FUNCTION a_sync_discount_usage_columns() RETURNS TRIGGER AS $$
BEGIN
  NEW.discountid := COALESCE(NEW.discountid, NEW.discount_id);
  NEW.userid := COALESCE(NEW.userid, NEW.user_id);
  NEW.discount_id := COALESCE(NEW.discount_id, NEW.discountid);
  NEW.user_id := COALESCE(NEW.user_id, NEW.userid);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS a_sync_discount_usage_columns_trigger ON DiscountUsageEntity;
CREATE TRIGGER a_sync_discount_usage_columns_trigger BEFORE INSERT ON DiscountUsageEntity
  FOR EACH ROW EXECUTE FUNCTION a_sync_discount_usage_columns();

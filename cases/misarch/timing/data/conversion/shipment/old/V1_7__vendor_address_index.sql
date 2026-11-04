-- The vendor address (WHERE userId IS NULL ORDER BY version DESC LIMIT 1, used by return's createReturn) scanned and
-- sorted all 52k address copies (1.8 ms). Vendor addresses are few, so a partial index on version holds only them.
CREATE INDEX addressEntity_vendor_version ON AddressEntity (version DESC) WHERE userId IS NULL;

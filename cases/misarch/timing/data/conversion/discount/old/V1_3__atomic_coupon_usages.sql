-- Defect fix (docs/fixes/discount.md Q10). update_coupon_usages read CouponEntity.usages without a lock, added 1 and
-- wrote the result back: two concurrent redemptions of one coupon could both read n and both write n + 1 (READ
-- COMMITTED), losing a redemption and letting maxUsages be exceeded. The increment is now one UPDATE: a concurrent
-- redemption's row lock makes it wait, then it increments the committed count. Over the limit it raises the same
-- exception as before, which rolls the increment back with the insert. V1_1 stays byte-identical (checksum).
CREATE OR REPLACE FUNCTION update_coupon_usages()
RETURNS TRIGGER AS $$
DECLARE
    current_usages INTEGER;
    max_usages INTEGER;
BEGIN
    UPDATE CouponEntity
    SET usages = usages + 1
    WHERE id = NEW.couponId
    RETURNING usages, maxUsages
    INTO current_usages, max_usages;

    IF max_usages IS NOT NULL AND current_usages > max_usages THEN
        RAISE EXCEPTION 'Coupon has been used too often';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

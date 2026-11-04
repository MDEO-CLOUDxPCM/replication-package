CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE UserEntity (
    id UUID PRIMARY KEY UNIQUE
);

CREATE TABLE ProductEntity (
    id UUID PRIMARY KEY UNIQUE
);

CREATE TABLE ProductVariantEntity (
    id UUID PRIMARY KEY UNIQUE,
    productId UUID NOT NULL
);

CREATE TABLE CategoryEntity (
    id UUID PRIMARY KEY UNIQUE
);

CREATE TABLE ProductToCategoryEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    productId UUID NOT NULL,
    categoryId UUID NOT NULL,
    UNIQUE (productId, categoryId)
);

CREATE TABLE DiscountEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    discount DOUBLE PRECISION NOT NULL,
    maxUsagesPerUser INTEGER NULL,
    validFrom TIMESTAMPTZ NOT NULL,
    validUntil TIMESTAMPTZ NOT NULL,
    minOrderAmount INTEGER NULL
);

CREATE TABLE CouponEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    usages INTEGER NOT NULL DEFAULT 0,
    maxUsages INTEGER NULL,
    validFrom TIMESTAMPTZ NOT NULL,
    validUntil TIMESTAMPTZ NOT NULL,
    code VARCHAR(255) NOT NULL,
    discountId UUID NOT NULL,
    FOREIGN KEY (discountId) REFERENCES DiscountEntity(id),
    UNIQUE (code)
);

CREATE TABLE CouponRedemptionEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    couponId UUID NOT NULL,
    userId UUID NOT NULL,
    FOREIGN KEY (couponId) REFERENCES CouponEntity(id),
    FOREIGN KEY (userId) REFERENCES UserEntity(id),
    UNIQUE (couponId, userId)
);

CREATE TABLE DiscountToProductEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    discountId UUID NOT NULL,
    productId UUID NOT NULL,
    FOREIGN KEY (discountId) REFERENCES DiscountEntity(id),
    FOREIGN KEY (productId) REFERENCES ProductEntity(id),
    UNIQUE (discountId, productId)
);

CREATE TABLE DiscountToCategoryEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    discountId UUID NOT NULL,
    categoryId UUID NOT NULL,
    FOREIGN KEY (discountId) REFERENCES DiscountEntity(id),
    FOREIGN KEY (categoryId) REFERENCES CategoryEntity(id),
    UNIQUE (discountId, categoryId)
);

CREATE TABLE DiscountToProductVariantEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    discountId UUID NOT NULL,
    productVariantId UUID NOT NULL,
    FOREIGN KEY (discountId) REFERENCES DiscountEntity(id),
    FOREIGN KEY (productVariantId) REFERENCES ProductVariantEntity(id),
    UNIQUE (discountId, productVariantId)
);

CREATE TABLE DiscountUsageEntity(
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    discountId UUID NOT NULL,
    userId UUID NOT NULL,
    usages BIGINT NOT NULL DEFAULT 0,
    FOREIGN KEY (discountId) REFERENCES DiscountEntity(id),
    FOREIGN KEY (userId) REFERENCES UserEntity(id),
    UNIQUE (discountId, userId)
);
)

CREATE OR REPLACE FUNCTION update_coupon_usages()
RETURNS TRIGGER AS $$
DECLARE
    current_usages INTEGER;
    max_usages INTEGER;
BEGIN
    SELECT couponEntity.usages, couponEntity.maxUsages
    INTO current_usages, max_usages
    FROM CouponEntity couponEntity
    WHERE couponEntity.id = NEW.couponId;

    current_usages := current_usages + 1;

    IF max_usages IS NOT NULL AND current_usages > max_usages THEN
        RAISE EXCEPTION 'Coupon has been used too often';
    END IF;

    UPDATE CouponEntity
    SET usages = current_usages
    WHERE id = NEW.couponId;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_insert_update_coupon_usages
BEFORE INSERT ON CouponRedemptionEntity
FOR EACH ROW
EXECUTE FUNCTION update_coupon_usages();

CREATE OR REPLACE FUNCTION check_discount_usages()
RETURNS TRIGGER AS $$
DECLARE
    max_usages_per_user INTEGER;
BEGIN
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.usages > OLD.usages) THEN
        SELECT maxUsagesPerUser
        INTO max_usages_per_user
        FROM DiscountEntity
        WHERE id = NEW.discountId;

        IF max_usages_per_user IS NOT NULL AND max_usages_per_user < NEW.usages THEN
            RAISE EXCEPTION 'The user has applied the discount too often';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_discount_usages_trigger
BEFORE INSERT OR UPDATE OF usages ON DiscountUsageEntity
FOR EACH ROW
EXECUTE FUNCTION check_discount_usages();

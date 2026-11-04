INSERT INTO CategoryEntity (id, name, description) VALUES ('81000000-0000-4000-8000-0000000000c1', 'Shoes', 'd');
INSERT INTO CategoryCharacteristicEntity (id, discriminator, name, description, categoryId)
    VALUES ('81000000-0000-4000-8000-0000000000c2', 'TextCategoryCharacteristic', 'Colour', 'd', '81000000-0000-4000-8000-0000000000c1');
INSERT INTO ProductEntity (id, internalName, isPubliclyVisible) VALUES ('81000000-0000-4000-8000-0000000000b1', 'p', true);
INSERT INTO ProductToCategoryEntity (id, productId, categoryId)
    VALUES (gen_random_uuid(), '81000000-0000-4000-8000-0000000000b1', '81000000-0000-4000-8000-0000000000c1');
INSERT INTO ProductVariantEntity (id, isPubliclyVisible, productId) VALUES ('81000000-0000-4000-8000-0000000000b2', true, '81000000-0000-4000-8000-0000000000b1');
INSERT INTO TaxRateEntity (id) VALUES ('81000000-0000-4000-8000-0000000000f1');
INSERT INTO ProductVariantVersionEntity (id, name, description, version, retailPrice, createdAt, canBeReturnedForDays,
        productVariantId, taxRateId, weight)
    VALUES ('81000000-0000-4000-8000-0000000000b3', 'Shoe', 'd', 1, 4999, now(), 30, '81000000-0000-4000-8000-0000000000b2',
            '81000000-0000-4000-8000-0000000000f1', 0.5);
UPDATE ProductVariantEntity SET currentVersion = '81000000-0000-4000-8000-0000000000b3';
UPDATE ProductEntity SET defaultVariantId = '81000000-0000-4000-8000-0000000000b2';
INSERT INTO CategoryCharacteristicValueEntity (id, discriminator, stringValue, categoryCharacteristicId, productVariantVersionId)
    VALUES (gen_random_uuid(), 'TextCategoryCharacteristicValue', 'red', '81000000-0000-4000-8000-0000000000c2', '81000000-0000-4000-8000-0000000000b3');
INSERT INTO MediaEntity (id) VALUES ('81000000-0000-4000-8000-0000000000e1');
INSERT INTO ProductVariantVersionToMediaEntity (id, productVariantVersionId, mediaId)
    VALUES (gen_random_uuid(), '81000000-0000-4000-8000-0000000000b3', '81000000-0000-4000-8000-0000000000e1');

-- MongoDB collection `paymentinformations`: {_id: string, paymentMethod, publicMethodDetails?, secretMethodDetails?,
-- user: {id}} (user/details are Mixed). Ids stay TEXT (case-sensitive string ids, byte-wise order via COLLATE "C").
-- The details keep the original JSON text (json, not jsonb: key order preserved).
CREATE TABLE PaymentInformationEntity (
    id                  TEXT COLLATE "C" PRIMARY KEY,
    paymentMethod       TEXT NOT NULL,
    publicMethodDetails JSON,
    secretMethodDetails JSON,
    userId              TEXT COLLATE "C",
    seq                 BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX paymentInformationEntity_userId ON PaymentInformationEntity (userId);
CREATE INDEX paymentInformationEntity_paymentMethod ON PaymentInformationEntity (paymentMethod);

-- MongoDB collection `payments`: {_id, totalAmount, status, paymentInformation: <info id> (Mixed + ref), payedAt?,
-- createdAt, updatedAt}; numberOfRetries is never stored by the original (column stays NULL).
CREATE TABLE PaymentEntity (
    id                 TEXT COLLATE "C" PRIMARY KEY,
    totalAmount        DOUBLE PRECISION NOT NULL,
    status             TEXT NOT NULL,
    paymentInformation TEXT COLLATE "C" NOT NULL,
    payedAt            TIMESTAMPTZ,
    numberOfRetries    DOUBLE PRECISION,
    createdAt          TIMESTAMPTZ NOT NULL,
    updatedAt          TIMESTAMPTZ NOT NULL,
    seq                BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX paymentEntity_paymentInformation ON PaymentEntity (paymentInformation);
CREATE INDEX paymentEntity_status ON PaymentEntity (status);
CREATE INDEX paymentEntity_createdAt ON PaymentEntity (createdAt);

-- MongoDB collection `openorders`: {_id: ObjectId, paymentId, order: <order object as received>}
CREATE TABLE OpenOrderEntity (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    paymentId TEXT COLLATE "C" NOT NULL,
    orderJson JSON NOT NULL
);
CREATE INDEX openOrderEntity_paymentId ON OpenOrderEntity (paymentId);

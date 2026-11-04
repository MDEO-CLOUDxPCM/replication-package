CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE UserEntity (
    id UUID PRIMARY KEY UNIQUE DEFAULT uuid_generate_v4(),
    username VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    gender VARCHAR(255),
    birthday TIMESTAMPTZ,
    dateJoined TIMESTAMPTZ NOT NULL
);

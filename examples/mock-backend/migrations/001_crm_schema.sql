-- crm schema: customers, interactions (orders), appointments.
--
-- Applied once at boot via db.ts's runMigrations(). Idempotent — every
-- CREATE has IF NOT EXISTS so re-running is a no-op. Tracked in
-- schema_migrations by filename (basename without .sql).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        text NOT NULL,
  surname     text NOT NULL,
  phone       text UNIQUE,
  email       citext UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS interactions (
  order_id     text PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  placed_at    timestamptz NOT NULL,
  status       text NOT NULL,
  channel      text NOT NULL,
  amount       numeric(10, 2) NOT NULL,
  currency     text NOT NULL DEFAULT 'USD',
  reason       text,
  resolution   text
);

CREATE INDEX IF NOT EXISTS interactions_customer_idx ON interactions (customer_id);
CREATE INDEX IF NOT EXISTS interactions_placed_at_idx ON interactions (placed_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  slot_start        timestamptz NOT NULL UNIQUE,
  slot_end          timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'scheduled',
  rescheduled_at    timestamptz,
  rescheduled_from  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_status_check CHECK (status IN ('scheduled', 'rescheduled', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS appointments_customer_idx ON appointments (customer_id);
CREATE INDEX IF NOT EXISTS appointments_slot_start_idx ON appointments (slot_start);

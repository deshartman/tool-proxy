// The connector's schema is created idempotently on every boot. The schema
// name is configurable via POSTGRES_SCHEMA (default "mcp_connector" per plan
// decision D15) — so this must be a function, not a static string. Callers
// pass the resolved schema name; the identifier is validated against a strict
// pattern before interpolation since pg has no built-in identifier quoter and
// the value comes from an env var.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function schemaSql(schema: string): string {
  if (!IDENT_RE.test(schema)) {
    throw new Error(
      `POSTGRES_SCHEMA must match /^[A-Za-z_][A-Za-z0-9_]*$/; got "${schema}".`,
    );
  }
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};
SET search_path TO ${schema};

-- Encryption metadata. Exactly one row, id=1. Populated on first boot.
CREATE TABLE IF NOT EXISTS ${schema}.encryption_meta (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    key_fingerprint   TEXT NOT NULL,             -- SHA-256 hex of the master key
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Controllers. Phase-1: exactly one row, enforced by the unique index below.
CREATE TABLE IF NOT EXISTS ${schema}.controllers (
    id                     TEXT PRIMARY KEY,         -- UUID minted in JS on insert
    name                   TEXT NOT NULL UNIQUE,     -- human-friendly ("twilio-prod")
    controller_url         TEXT NOT NULL,            -- https://... (not encrypted)
    connector_name         TEXT NOT NULL,            -- goes into WS X-Connector-Name header
    environment            TEXT,                     -- nullable, e.g. "dev" | "prod"
    auth_mode              TEXT NOT NULL CHECK (auth_mode IN ('static-bearer', 'oauth2-cc')),
    tunnel_auth_token_ct   BYTEA,                    -- sealed; NULL for oauth2-cc
    oauth_client_id        TEXT,                     -- not secret
    oauth_client_secret_ct BYTEA,                    -- sealed; NULL for static-bearer
    oauth_token_url        TEXT,
    registration_token_ct  BYTEA,                    -- sealed; may be NULL before first register-ack
    enabled                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_connected_at      TIMESTAMPTZ,
    last_disconnect_reason TEXT
);

-- Phase-1 gate: at most one row. Phase-2 will DROP this index.
CREATE UNIQUE INDEX IF NOT EXISTS one_controller_only ON ${schema}.controllers ((TRUE));
`;
}

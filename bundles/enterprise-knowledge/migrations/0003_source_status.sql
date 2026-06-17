-- 0003_source_status.sql — surface boot-time + refresh-time errors to the
-- Controller via sources_fetch.
--
-- status        — 'indexed' (default; previous behaviour) or 'failed'.
-- last_error    — null on success; populated when register or refresh raises.
-- last_attempted_at — wall-clock of the last register/refresh attempt,
--                     successful or not. Distinct from indexed_at, which
--                     only advances on a successful index.
--
-- Idempotent. Existing rows default to 'indexed' which matches what they
-- were before this column existed.

ALTER TABLE ek_sources
  ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'indexed';

ALTER TABLE ek_sources
  ADD COLUMN IF NOT EXISTS last_error        TEXT;

ALTER TABLE ek_sources
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;

-- Rename the old reader's `kind` constant to the new product id. Phase 4a
-- consolidates kind onto the products registry's id field; the previous
-- code used 'local_files' as a free-form tag. Idempotent — affects only
-- rows that predate the registry split.
UPDATE ek_sources SET kind = 'local' WHERE kind = 'local_files';

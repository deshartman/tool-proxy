-- 0001_init.sql — pgvector extension + ek_sources metadata table.
--
-- Applied idempotently by the bundle on startup when EK_VECTOR_STORE=pgvector.
-- The per-source vector tables (data_<source_id>) are created lazily by
-- LlamaIndex's PGVectorStore on first write — they are NOT created here.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ek_sources (
  source_id    TEXT        PRIMARY KEY,
  url          TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  indexed_at   TIMESTAMPTZ NOT NULL,
  doc_count    INTEGER     NOT NULL,
  chunk_hashes JSONB       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS ek_sources_url_idx ON ek_sources (url);

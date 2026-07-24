-- 0002_embedder_signature.sql — track which embedder produced each source's vectors.
--
-- pgvector tables fix their dimension at create time. If the customer
-- swaps EK_EMBEDDER (e.g. local bge-small at 384 dims → openai
-- text-embedding-3-small at 1536 dims) and queries an old source under
-- the new embedder, the math runs but returns nonsense. This column
-- carries a "provider:model" string set at register time; storage.query
-- compares it to the currently-loaded embedder and refuses on mismatch
-- with an actionable error.
--
-- Empty-string default lets us add NOT NULL without backfilling rows.
-- No real source rows exist yet (Phase 1 was never end-to-end verified).

ALTER TABLE ek_sources
  ADD COLUMN IF NOT EXISTS embedder_signature TEXT NOT NULL DEFAULT '';

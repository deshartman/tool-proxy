"""Source-metadata persistence — lands in step 4.

Per LLAMA-INDEX.md, when the backend is pgvector this writes to an
`ek_sources` table in the same Postgres as the chunk vectors (one backup
target, transactional consistency). When the backend is Chroma it falls
back to a sidecar SQLite alongside the Chroma directory.

Step 2's stub keeps everything in-process (`storage._StubStore`) so this
module is intentionally empty. The `record_source_metadata` /
`load_source_metadata` / `all_source_metadata` names that step 4 will
expose are documented in the plan.
"""

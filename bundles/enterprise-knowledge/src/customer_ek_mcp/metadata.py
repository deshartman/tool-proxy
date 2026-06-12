"""Source-metadata persistence — CRUD over the `ek_sources` table.

One row per registered source. The chunk_hashes column is a JSONB list of
sha256 hexdigests in chunk order; phase 3's `sources_refresh` diffs against
it. Phase 1 only writes the column; nothing reads it yet.

Connection model: open a fresh psycopg connection per call. EK is low-QPS
(register on procedure save, query at runtime, refresh on cron) so a pool
adds complexity without measurable benefit.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg


@dataclass
class SourceMeta:
    source_id: str
    url: str
    kind: str
    indexed_at: datetime
    doc_count: int
    chunk_hashes: list[str]


def record_source_metadata(
    *,
    dsn: str,
    source_id: str,
    url: str,
    kind: str,
    indexed_at: datetime,
    doc_count: int,
    chunk_hashes: list[str],
) -> None:
    """Insert or update the row for `source_id`. Idempotent on re-register."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ek_sources (source_id, url, kind, indexed_at, doc_count, chunk_hashes)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (source_id) DO UPDATE SET
              url = EXCLUDED.url,
              kind = EXCLUDED.kind,
              indexed_at = EXCLUDED.indexed_at,
              doc_count = EXCLUDED.doc_count,
              chunk_hashes = EXCLUDED.chunk_hashes
            """,
            (source_id, url, kind, indexed_at, doc_count, json.dumps(chunk_hashes)),
        )


def load_source_metadata(*, dsn: str, source_id: str) -> SourceMeta | None:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT source_id, url, kind, indexed_at, doc_count, chunk_hashes "
            "FROM ek_sources WHERE source_id = %s",
            (source_id,),
        )
        row = cur.fetchone()
        return _row_to_meta(row) if row else None


def all_source_metadata(*, dsn: str) -> list[SourceMeta]:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT source_id, url, kind, indexed_at, doc_count, chunk_hashes "
            "FROM ek_sources ORDER BY indexed_at DESC"
        )
        return [_row_to_meta(row) for row in cur.fetchall()]


def _row_to_meta(row: tuple[Any, ...]) -> SourceMeta:
    source_id, url, kind, indexed_at, doc_count, chunk_hashes = row
    return SourceMeta(
        source_id=source_id,
        url=url,
        kind=kind,
        indexed_at=indexed_at,
        doc_count=doc_count,
        chunk_hashes=list(chunk_hashes) if chunk_hashes else [],
    )

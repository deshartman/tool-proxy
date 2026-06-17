"""Source-metadata persistence — CRUD over the `ek_sources` table.

One row per registered source. The chunk_hashes column is a JSONB list of
sha256 hexdigests in chunk order; phase 3's `sources_refresh` diffs against
it.

Connection model: open a fresh psycopg connection per call. EK is low-QPS
(register on procedure save, query at runtime, refresh on cron) so a pool
adds complexity without measurable benefit.

Status surface (added in migration 0003):
- `status` is 'indexed' on success, 'failed' when register or refresh
  raises and the failure is persisted via `record_source_failure`.
- `last_error` carries the exception message; null when status='indexed'.
- `last_attempted_at` tracks the most recent register/refresh attempt
  whether it succeeded or failed; `indexed_at` only advances on success.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import psycopg


STATUS_INDEXED = "indexed"
STATUS_FAILED = "failed"


@dataclass
class SourceMeta:
    source_id: str
    url: str
    kind: str
    indexed_at: datetime
    doc_count: int
    chunk_hashes: list[str]
    embedder_signature: str
    status: str = STATUS_INDEXED
    last_error: str | None = None
    last_attempted_at: datetime | None = None


def record_source_metadata(
    *,
    dsn: str,
    source_id: str,
    url: str,
    kind: str,
    indexed_at: datetime,
    doc_count: int,
    chunk_hashes: list[str],
    embedder_signature: str,
) -> None:
    """Insert or update a successful row for `source_id`. Idempotent on re-register.

    Sets status='indexed', clears last_error, and stamps last_attempted_at
    = indexed_at — a successful index supersedes any prior failure.
    """
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ek_sources (
              source_id, url, kind, indexed_at, doc_count, chunk_hashes,
              embedder_signature, status, last_error, last_attempted_at
            )
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, NULL, %s)
            ON CONFLICT (source_id) DO UPDATE SET
              url = EXCLUDED.url,
              kind = EXCLUDED.kind,
              indexed_at = EXCLUDED.indexed_at,
              doc_count = EXCLUDED.doc_count,
              chunk_hashes = EXCLUDED.chunk_hashes,
              embedder_signature = EXCLUDED.embedder_signature,
              status = EXCLUDED.status,
              last_error = NULL,
              last_attempted_at = EXCLUDED.last_attempted_at
            """,
            (
                source_id, url, kind, indexed_at, doc_count,
                json.dumps(chunk_hashes), embedder_signature,
                STATUS_INDEXED, indexed_at,
            ),
        )


def record_source_failure(
    *,
    dsn: str,
    source_id: str,
    url: str,
    kind: str,
    error: str,
    attempted_at: datetime | None = None,
) -> None:
    """Persist a failure on register or refresh.

    Two cases this handles:

    1. First-time register failure — no prior row exists. We insert a row
       with status='failed', empty chunk_hashes, doc_count=0, and a
       sentinel `indexed_at = epoch` so list_sources can sort sensibly.
    2. Refresh failure on an existing row — chunks are still queryable.
       We update status, last_error, last_attempted_at; we do NOT touch
       indexed_at, doc_count, chunk_hashes, or embedder_signature.

    The kind is the product id, derived by the caller. On first-register
    failure where url_match couldn't even pick a product, the caller
    should pass kind='unknown' (or similar) — that string is informational
    only; nothing dispatches on it for failed rows.
    """
    if attempted_at is None:
        attempted_at = datetime.now(timezone.utc)

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ek_sources (
              source_id, url, kind, indexed_at, doc_count, chunk_hashes,
              embedder_signature, status, last_error, last_attempted_at
            )
            VALUES (%s, %s, %s, %s, 0, '[]'::jsonb, '', %s, %s, %s)
            ON CONFLICT (source_id) DO UPDATE SET
              status = EXCLUDED.status,
              last_error = EXCLUDED.last_error,
              last_attempted_at = EXCLUDED.last_attempted_at
            """,
            (
                source_id, url, kind, _epoch(),
                STATUS_FAILED, error, attempted_at,
            ),
        )


def load_source_metadata(*, dsn: str, source_id: str) -> SourceMeta | None:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(_SELECT_ALL_COLS + " WHERE source_id = %s", (source_id,))
        row = cur.fetchone()
        return _row_to_meta(row) if row else None


def all_source_metadata(*, dsn: str) -> list[SourceMeta]:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(_SELECT_ALL_COLS + " ORDER BY indexed_at DESC")
        return [_row_to_meta(row) for row in cur.fetchall()]


_SELECT_ALL_COLS = (
    "SELECT source_id, url, kind, indexed_at, doc_count, chunk_hashes, "
    "embedder_signature, status, last_error, last_attempted_at "
    "FROM ek_sources"
)


def _row_to_meta(row: tuple[Any, ...]) -> SourceMeta:
    (
        source_id, url, kind, indexed_at, doc_count, chunk_hashes,
        embedder_signature, status, last_error, last_attempted_at,
    ) = row
    return SourceMeta(
        source_id=source_id,
        url=url,
        kind=kind,
        indexed_at=indexed_at,
        doc_count=doc_count,
        chunk_hashes=list(chunk_hashes) if chunk_hashes else [],
        embedder_signature=embedder_signature or "",
        status=status or STATUS_INDEXED,
        last_error=last_error,
        last_attempted_at=last_attempted_at,
    )


def _epoch() -> datetime:
    """Sentinel `indexed_at` for never-successfully-indexed failed rows."""
    return datetime(1970, 1, 1, tzinfo=timezone.utc)

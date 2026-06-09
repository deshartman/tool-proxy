"""Storage abstraction — step 2 ships a stub in-memory implementation so the
tool surface is exercisable end-to-end without LlamaIndex / Postgres / Chroma.

Step 4 replaces `_StubStore` with a real LlamaIndex-backed store that
dispatches on `Settings.backend` to either `PGVectorStore` or
`ChromaVectorStore`. The public functions in this module are the contract;
the controller-side and connector-side smoke tests target this surface.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Lock
from typing import Any


@dataclass
class SourceMeta:
    source_id: str
    url: str
    indexed_at: str
    doc_count: int


@dataclass
class _StubStore:
    """In-memory placeholder for the eventual vector store + metadata table.

    Holds a flat list of (chunk_text, source_id) so `query` returns
    deterministic placeholder content. Replaced wholesale in step 4.
    """

    sources: dict[str, SourceMeta] = field(default_factory=dict)
    chunks: dict[str, list[str]] = field(default_factory=dict)
    lock: Lock = field(default_factory=Lock)


_store = _StubStore()


def _stable_source_id(url: str) -> str:
    return "src_" + hashlib.sha1(url.encode()).hexdigest()[:12]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def register_source(url: str) -> dict[str, Any]:
    source_id = _stable_source_id(url)
    with _store.lock:
        if source_id in _store.sources:
            existing = _store.sources[source_id]
            return {
                "source_id": existing.source_id,
                "status": "already_indexed",
                "doc_count": existing.doc_count,
                "indexed_at": existing.indexed_at,
            }
        # Stub: pretend we fetched, parsed, chunked, embedded the URL.
        # Real implementation lands in step 4.
        placeholder_chunks = [
            f"[stub chunk {i}] from {url}"
            for i in range(3)
        ]
        _store.chunks[source_id] = placeholder_chunks
        meta = SourceMeta(
            source_id=source_id,
            url=url,
            indexed_at=_now_iso(),
            doc_count=len(placeholder_chunks),
        )
        _store.sources[source_id] = meta
        return {
            "source_id": meta.source_id,
            "status": "indexed",
            "doc_count": meta.doc_count,
            "indexed_at": meta.indexed_at,
        }


def query(source_id: str, query_text: str, k: int) -> dict[str, Any]:
    with _store.lock:
        if source_id not in _store.sources:
            raise ValueError(f"unknown source_id {source_id!r}")
        chunks = _store.chunks.get(source_id, [])
    return {
        "chunks": [
            {
                "text": chunk,
                "score": 1.0 - (i * 0.1),
                "citation": {"source_id": source_id, "doc_id": f"doc_{i}", "char_offset": 0},
            }
            for i, chunk in enumerate(chunks[:k])
        ],
        "source_meta": {"source_id": source_id, "k": k, "query": query_text},
    }


def refresh(source_id: str, force: bool = False) -> dict[str, Any]:
    with _store.lock:
        meta = _store.sources.get(source_id)
        if meta is None:
            raise ValueError(f"unknown source_id {source_id!r}")
        # Stub: pretend nothing changed unless force=True.
        if force:
            meta.indexed_at = _now_iso()
            return {
                "source_id": source_id,
                "changed": True,
                "doc_count": meta.doc_count,
                "indexed_at": meta.indexed_at,
            }
        return {
            "source_id": source_id,
            "changed": False,
            "doc_count": meta.doc_count,
            "indexed_at": meta.indexed_at,
        }


def list_sources() -> list[dict[str, Any]]:
    with _store.lock:
        return [
            {
                "source_id": m.source_id,
                "url": m.url,
                "indexed_at": m.indexed_at,
                "doc_count": m.doc_count,
            }
            for m in _store.sources.values()
        ]

"""Storage layer — LlamaIndex over pgvector.

The four public functions (`register_source`, `query`, `refresh`,
`list_sources`) keep the JSON shape today's stub returns, so the
MCP wire contract with the controller doesn't move.

Module import does three things, once per process:
  1. Load Settings (raises if EK_PGVECTOR_DSN is unset).
  2. Apply migrations from migrations/*.sql idempotently.
  3. Load the embedder via `embedder.load_embedder()` and bind it
     globally on `LlamaSettings.embed_model`.

Per-source-id table model: each registered source gets its own
`data_<source_id>` table created lazily by PGVectorStore. `force=True`
refresh drops and recreates that table.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import psycopg
from llama_index.core import Settings as LlamaSettings
from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import BaseNode
from llama_index.vector_stores.postgres import PGVectorStore

from . import embedder, metadata, readers, settings

logger = logging.getLogger(__name__)

_settings = settings.load()
_lock = Lock()
_node_parser = SentenceSplitter()


def _apply_migrations() -> None:
    migrations_dir = Path(__file__).resolve().parent.parent.parent / "migrations"
    if not migrations_dir.is_dir():
        logger.warning("migrations dir not found: %s", migrations_dir)
        return
    files = sorted(migrations_dir.glob("*.sql"))
    if not files:
        return
    with psycopg.connect(_settings.pgvector_dsn) as conn, conn.cursor() as cur:
        for path in files:
            logger.info("applying migration %s", path.name)
            cur.execute(path.read_text())


_apply_migrations()
_embedder = embedder.load_embedder()
LlamaSettings.embed_model = _embedder.model
logger.info("embedder loaded: %s (dim=%d)", _embedder.signature, _embedder.embed_dim)


def _stable_source_id(url: str) -> str:
    return "src_" + hashlib.sha1(url.encode()).hexdigest()[:12]


def _table_name(source_id: str) -> str:
    return f"data_{source_id}"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _vector_store(source_id: str) -> PGVectorStore:
    parsed = urlparse(_settings.pgvector_dsn)
    return PGVectorStore.from_params(
        database=(parsed.path or "/").lstrip("/"),
        host=parsed.hostname or "localhost",
        port=parsed.port or 5432,
        user=parsed.username or "",
        password=parsed.password or "",
        table_name=_table_name(source_id),
        embed_dim=_embedder.embed_dim,
    )


def _hash_chunk(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


def _node_text(node: BaseNode) -> str:
    return node.get_content(metadata_mode="none")


def _index_from_scratch(
    source_id: str, url: str, kind_hint: str | None = None
) -> tuple[int, int, datetime]:
    """Fetch+chunk+embed every chunk; persist row. Returns (doc_count, chunk_count, indexed_at).

    Used by register_source for new sources and by refresh(force=True) after
    the per-source vector table has been dropped.
    """
    documents, kind = readers.pick_reader(url, kind=kind_hint)
    if not documents:
        raise ValueError(f"no documents found at {url!r}")

    nodes = _node_parser.get_nodes_from_documents(documents)
    chunk_hashes = [_hash_chunk(_node_text(n)) for n in nodes]

    vector_store = _vector_store(source_id)
    storage_context = StorageContext.from_defaults(vector_store=vector_store)
    VectorStoreIndex(nodes=nodes, storage_context=storage_context)

    indexed_at = _now_utc()
    metadata.record_source_metadata(
        dsn=_settings.pgvector_dsn,
        source_id=source_id,
        url=url,
        kind=kind,
        indexed_at=indexed_at,
        doc_count=len(documents),
        chunk_hashes=chunk_hashes,
        embedder_signature=_embedder.signature,
    )
    logger.info(
        "indexed source_id=%s url=%s docs=%d chunks=%d",
        source_id, url, len(documents), len(nodes),
    )
    return len(documents), len(nodes), indexed_at


def _drop_source_table(source_id: str) -> None:
    """Drop the per-source vector table so a fresh index can be built.

    PGVectorStore prefixes its own 'data_' onto the table_name we pass it,
    so the actual table name in Postgres is data_data_<source_id>.
    """
    table = f"data_{_table_name(source_id)}"
    with psycopg.connect(_settings.pgvector_dsn) as conn, conn.cursor() as cur:
        cur.execute(f'DROP TABLE IF EXISTS "{table}"')
    logger.info("dropped vector table %s for source_id=%s", table, source_id)


def register_source(url: str) -> dict[str, Any]:
    source_id = _stable_source_id(url)
    with _lock:
        existing = metadata.load_source_metadata(
            dsn=_settings.pgvector_dsn, source_id=source_id
        )
        if existing is not None:
            return {
                "source_id": existing.source_id,
                "status": "already_indexed",
                "doc_count": existing.doc_count,
                "indexed_at": existing.indexed_at.isoformat(),
            }
        doc_count, _, indexed_at = _index_from_scratch(source_id, url)
        return {
            "source_id": source_id,
            "status": "indexed",
            "doc_count": doc_count,
            "indexed_at": indexed_at.isoformat(),
        }


def query(source_id: str, query_text: str, k: int) -> dict[str, Any]:
    meta = metadata.load_source_metadata(
        dsn=_settings.pgvector_dsn, source_id=source_id
    )
    if meta is None:
        raise ValueError(f"unknown source_id {source_id!r}")

    if meta.embedder_signature and meta.embedder_signature != _embedder.signature:
        raise RuntimeError(
            f"embedder mismatch on source {source_id!r}: indexed with "
            f"{meta.embedder_signature!r}, current embedder is "
            f"{_embedder.signature!r}. Re-index with sources_refresh "
            f"(force=true), or restore the original EK_EMBEDDER setting."
        )

    vector_store = _vector_store(source_id)
    index = VectorStoreIndex.from_vector_store(vector_store=vector_store)
    retriever = index.as_retriever(similarity_top_k=k)
    nodes = retriever.retrieve(query_text)

    chunks = []
    for i, node_with_score in enumerate(nodes):
        node = node_with_score.node
        chunks.append({
            "text": _node_text(node),
            "score": float(node_with_score.score) if node_with_score.score is not None else 0.0,
            "citation": {
                "source_id": source_id,
                "doc_id": node.ref_doc_id or f"node_{i}",
                "char_offset": getattr(node, "start_char_idx", None) or 0,
            },
        })
    return {
        "chunks": chunks,
        "source_meta": {"source_id": source_id, "k": k, "query": query_text},
    }


def refresh(source_id: str, force: bool = False) -> dict[str, Any]:
    """Re-fetch and re-index a source.

    With force=True: drop the per-source vector table and re-embed every
    chunk. Use after switching EK_EMBEDDER (signature mismatch on query)
    or when the source format changed in ways the chunk-hash diff can't
    detect.

    With force=False: re-fetch, re-chunk, hash each chunk, embed only the
    documents whose chunks differ from what's stored. Embedder calls drop
    sharply on small edits.

    Refresh always runs under the bundle's currently-loaded embedder. If
    that's a different embedder than the source was originally indexed
    with, force=False would mix vector spaces in one table — we refuse
    in that case and tell the caller to retry with force=True.
    """
    with _lock:
        meta = metadata.load_source_metadata(
            dsn=_settings.pgvector_dsn, source_id=source_id
        )
        if meta is None:
            raise ValueError(f"unknown source_id {source_id!r}")

        if force:
            _drop_source_table(source_id)
            doc_count, chunk_count, indexed_at = _index_from_scratch(
                source_id=source_id, url=meta.url, kind_hint=meta.kind
            )
            return {
                "source_id": source_id,
                "changed": True,
                "force": True,
                "doc_count": doc_count,
                "chunks_reembedded": chunk_count,
                "indexed_at": indexed_at.isoformat(),
            }

        if meta.embedder_signature and meta.embedder_signature != _embedder.signature:
            raise RuntimeError(
                f"embedder mismatch on source {source_id!r}: indexed with "
                f"{meta.embedder_signature!r}, current embedder is "
                f"{_embedder.signature!r}. Re-run sources_refresh with "
                f"force=true to re-index under the current embedder."
            )

        documents, _ = readers.pick_reader(meta.url, kind=meta.kind)
        if not documents:
            raise ValueError(f"no documents found at {meta.url!r}")

        new_nodes = _node_parser.get_nodes_from_documents(documents)
        new_hashes = [_hash_chunk(_node_text(n)) for n in new_nodes]
        old_hashes = set(meta.chunk_hashes)

        if set(new_hashes) == old_hashes:
            logger.info("refresh source_id=%s unchanged (%d chunks)", source_id, len(new_hashes))
            return {
                "source_id": source_id,
                "changed": False,
                "force": False,
                "doc_count": meta.doc_count,
                "chunks_reembedded": 0,
                "indexed_at": meta.indexed_at.isoformat(),
            }

        # Identify which ref_doc_ids contain new (i.e. previously unseen)
        # chunks — those documents get fully re-indexed. Documents whose
        # every chunk hash already appears in old_hashes are left alone.
        changed_ref_doc_ids: set[str] = set()
        for node, h in zip(new_nodes, new_hashes):
            if h not in old_hashes and node.ref_doc_id:
                changed_ref_doc_ids.add(node.ref_doc_id)

        nodes_to_insert = [
            n for n in new_nodes if n.ref_doc_id in changed_ref_doc_ids
        ]

        vector_store = _vector_store(source_id)
        for ref_doc_id in changed_ref_doc_ids:
            vector_store.delete(ref_doc_id=ref_doc_id)

        index = VectorStoreIndex.from_vector_store(vector_store=vector_store)
        if nodes_to_insert:
            index.insert_nodes(nodes_to_insert)

        indexed_at = _now_utc()
        metadata.record_source_metadata(
            dsn=_settings.pgvector_dsn,
            source_id=source_id,
            url=meta.url,
            kind=meta.kind,
            indexed_at=indexed_at,
            doc_count=len(documents),
            chunk_hashes=new_hashes,
            embedder_signature=_embedder.signature,
        )
        logger.info(
            "refresh source_id=%s changed_docs=%d reembedded_chunks=%d",
            source_id, len(changed_ref_doc_ids), len(nodes_to_insert),
        )
        return {
            "source_id": source_id,
            "changed": True,
            "force": False,
            "doc_count": len(documents),
            "chunks_reembedded": len(nodes_to_insert),
            "indexed_at": indexed_at.isoformat(),
        }


def list_sources() -> list[dict[str, Any]]:
    return [
        {
            "source_id": m.source_id,
            "url": m.url,
            "indexed_at": m.indexed_at.isoformat(),
            "doc_count": m.doc_count,
        }
        for m in metadata.all_source_metadata(dsn=_settings.pgvector_dsn)
    ]

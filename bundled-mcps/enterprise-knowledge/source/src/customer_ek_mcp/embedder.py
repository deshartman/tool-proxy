"""Pluggable embedder factory.

Customers pick an embedding provider via `EK_EMBEDDER` in the bundle's
.env. The choice is baked into each source's metadata at register time
(see `embedder_signature` on `ek_sources`); switching providers later
forces a re-index.

Module load is part of `storage.py` boot — `load_embedder()` raises if
the chosen provider's required env vars are missing or malformed. The
EK MCP child fails to start, the connector spawner readiness probe
trips, and the customer sees the error in connector logs before any
tool call is dispatched (matches CLAUDE.md's fail-fast posture for
Type 1/3 child boot).

Public surface:
  load_embedder() -> LoadedEmbedder

The `LoadedEmbedder` carries:
  - model: a llama-index BaseEmbedding subclass instance, ready to use
    as `LlamaSettings.embed_model`.
  - signature: a "provider:model" string persisted with every source.
  - embed_dim: the vector dimension for the provider's chosen model.
    pgvector tables are created with this dim at register time.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from llama_index.core.embeddings import BaseEmbedding


# ── Per-(provider, model) embedding dimensions ─────────────────────────
# pgvector tables are created with a fixed dim at register time, so we
# need to know this number BEFORE the first embed call.
#
# Add new entries here when adding support for new Ollama models.

EMBED_DIMS: dict[tuple[str, str], int] = {
    ("ollama", "nomic-embed-text"): 768,
}

DEFAULT_OLLAMA_MODEL = "nomic-embed-text"


@dataclass(frozen=True)
class LoadedEmbedder:
    model: BaseEmbedding
    signature: str
    embed_dim: int


def _embed_dim(provider: str, model: str) -> int:
    try:
        return EMBED_DIMS[(provider, model)]
    except KeyError as exc:
        raise RuntimeError(
            f"unknown embedding dimension for {provider}:{model}. "
            f"Add the dim to EMBED_DIMS in embedder.py."
        ) from exc


def _load_ollama() -> LoadedEmbedder:
    from llama_index.embeddings.ollama import OllamaEmbedding

    base_url = os.environ.get("OLLAMA_URL", "http://embedding:11434").rstrip("/")
    model_name = os.environ.get("EK_OLLAMA_MODEL", "").strip() or DEFAULT_OLLAMA_MODEL
    return LoadedEmbedder(
        model=OllamaEmbedding(model_name=model_name, base_url=base_url),
        signature=f"ollama:{model_name}",
        embed_dim=_embed_dim("ollama", model_name),
    )


def load_embedder() -> LoadedEmbedder:
    """Return the configured embedder (Ollama sidecar only)."""
    provider = os.environ.get("EK_EMBEDDER", "ollama").strip().lower()

    if provider == "ollama":
        return _load_ollama()

    # Removed providers — provide clear migration hints
    if provider in ("local", "openai", "azure_openai"):
        raise RuntimeError(
            f"EK_EMBEDDER={provider!r} was removed. The bundle now uses "
            f"Ollama exclusively. Set EK_EMBEDDER=ollama and ensure the "
            f"Ollama sidecar is running (see bundled-mcps/enterprise-knowledge/EMBEDDING-SIDECAR.md). "
            f"Re-index existing sources with sources_refresh(force=true)."
        )

    raise RuntimeError(
        f"unknown EK_EMBEDDER={provider!r}. Supported: ollama. "
        f"(The 'local', 'openai', and 'azure_openai' providers were removed.)"
    )

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


# ── Per-provider model defaults ───────────────────────────────────────
# Used when EK_EMBED_MODEL is unset for the chosen provider.

DEFAULT_LOCAL_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_OPENAI_MODEL = "text-embedding-3-small"

# ── Per-(provider, model) embedding dimensions ────────────────────────
# pgvector tables are created with a fixed dim at register time, so we
# need to know this number BEFORE the first embed call. We hardcode the
# common cases rather than probing the model — probing for HF means
# loading 130MB before knowing the dim, and probing for OpenAI means a
# real API call at boot just to size a column.
#
# Add new entries here when adding new model defaults above.

EMBED_DIMS: dict[tuple[str, str], int] = {
    ("local", "BAAI/bge-small-en-v1.5"): 384,
    ("openai", "text-embedding-3-small"): 1536,
    ("openai", "text-embedding-3-large"): 3072,
    ("openai", "text-embedding-ada-002"): 1536,
}


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


def _load_local() -> LoadedEmbedder:
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding

    model_name = os.environ.get("EK_EMBED_MODEL", "").strip() or DEFAULT_LOCAL_MODEL
    return LoadedEmbedder(
        model=HuggingFaceEmbedding(model_name=model_name),
        signature=f"local:{model_name}",
        embed_dim=_embed_dim("local", model_name),
    )


# Pinned OpenAI API endpoint. The openai SDK silently honors OPENAI_BASE_URL
# (and OPENAI_API_BASE) in process env, which would let an attacker — or an
# accidentally-misconfigured deployment — redirect every embedding call to
# arbitrary host. We refuse to boot if the env tries to override it.
OPENAI_API_BASE_PINNED = "https://api.openai.com/v1"

# Env vars that, if any are set when EK_EMBEDDER=openai, indicate a likely
# operator misconfiguration (two providers' creds left in the same .env).
# We refuse to boot rather than silently honoring whichever one happens to
# win the dispatch.
_AZURE_ENV_VARS = (
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_VERSION",
)


def _load_openai() -> LoadedEmbedder:
    from llama_index.embeddings.openai import OpenAIEmbedding

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "EK_EMBEDDER=openai requires OPENAI_API_KEY. Set it in "
            "mcp/bundled/enterprise-knowledge/.env (see .env.example)."
        )

    for var in ("OPENAI_BASE_URL", "OPENAI_API_BASE"):
        override = os.environ.get(var, "").strip()
        if override and override.rstrip("/") != OPENAI_API_BASE_PINNED.rstrip("/"):
            raise RuntimeError(
                f"EK_EMBEDDER=openai refuses to honor {var}={override!r}. "
                f"This bundle pins egress to {OPENAI_API_BASE_PINNED}. "
                f"Unset {var} in mcp/bundled/enterprise-knowledge/.env, "
                f"or pick EK_EMBEDDER=azure_openai when it lands."
            )

    leaked = [v for v in _AZURE_ENV_VARS if os.environ.get(v, "").strip()]
    if leaked:
        raise RuntimeError(
            f"EK_EMBEDDER=openai but Azure env vars are also set: {leaked}. "
            f"Two providers' creds in one .env is almost always a "
            f"misconfiguration. Pick one provider and remove the other "
            f"block from mcp/bundled/enterprise-knowledge/.env."
        )

    model_name = os.environ.get("EK_EMBED_MODEL", "").strip() or DEFAULT_OPENAI_MODEL
    return LoadedEmbedder(
        model=OpenAIEmbedding(
            model=model_name,
            api_key=api_key,
            api_base=OPENAI_API_BASE_PINNED,
        ),
        signature=f"openai:{model_name}",
        embed_dim=_embed_dim("openai", model_name),
    )


def load_embedder() -> LoadedEmbedder:
    provider = os.environ.get("EK_EMBEDDER", "local").strip().lower()
    if provider == "local":
        return _load_local()
    if provider == "openai":
        return _load_openai()
    if provider == "azure_openai":
        raise NotImplementedError(
            "EK_EMBEDDER=azure_openai is documented in .env.example but not "
            "yet wired. Use 'openai' or 'local' for now; Azure lands in a "
            "follow-up."
        )
    raise RuntimeError(
        f"unknown EK_EMBEDDER={provider!r}. Supported: local, openai "
        f"(azure_openai planned)."
    )

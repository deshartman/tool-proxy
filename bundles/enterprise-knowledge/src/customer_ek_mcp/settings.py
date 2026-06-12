"""Configuration loaded from the bundle's `.env` (passed in by the connector
as the child process's environment).

pgvector is the only backend in v1. EK_PGVECTOR_DSN is required at boot —
missing or empty fails fast in `load()`. Embedder selection is owned by
`embedder.py` (reads EK_EMBEDDER + per-provider env vars directly). The
Confluence-related env vars land later (see EK-IMPLEMENTATION.md
"Phase 2 (parked)") and are read by `readers.py` not here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    pgvector_dsn: str


def load() -> Settings:
    dsn = os.environ.get("EK_PGVECTOR_DSN", "").strip()
    if not dsn:
        raise RuntimeError(
            "EK_PGVECTOR_DSN is required. Set it in "
            "mcp/bundled/enterprise-knowledge/.env (see .env.example)."
        )
    return Settings(pgvector_dsn=dsn)

"""Configuration loaded from the bundle's `.env` (passed in by the connector
as the child process's environment).

Step 2 reads only what the stub backend needs. Step 4 grows this to cover
embedding model choice, source-system credentials, and refresh cadence
hints.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


VectorStoreBackend = Literal["pgvector", "chroma", "stub"]


@dataclass(frozen=True)
class Settings:
    backend: VectorStoreBackend
    pgvector_dsn: str | None
    chroma_path: str | None


def load() -> Settings:
    backend = os.environ.get("EK_VECTOR_STORE", "stub").lower()
    if backend not in {"pgvector", "chroma", "stub"}:
        raise ValueError(
            f"EK_VECTOR_STORE must be one of pgvector|chroma|stub; got {backend!r}"
        )
    return Settings(
        backend=backend,  # type: ignore[arg-type]
        pgvector_dsn=os.environ.get("EK_PGVECTOR_DSN"),
        chroma_path=os.environ.get("EK_CHROMA_PATH"),
    )

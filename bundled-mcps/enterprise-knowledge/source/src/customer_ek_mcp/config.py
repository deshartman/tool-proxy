"""EK configuration helpers for path validation and roots."""

from __future__ import annotations

import os
from pathlib import Path


def local_roots() -> list[Path]:
    """Return canonicalized allowed root paths for local file reading.

    Reads colon-separated `EK_LOCAL_ROOTS` environment variable.
    If unset or empty, returns an empty list (all local reads refused).
    """
    raw = os.environ.get("EK_LOCAL_ROOTS", "").strip()
    if not raw:
        return []
    roots: list[Path] = []
    for entry in raw.split(":"):
        cleaned = entry.strip()
        if cleaned:
            try:
                # Resolve canonical path (following symlinks)
                p = Path(cleaned).resolve()
                roots.append(p)
            except Exception:
                pass
    return roots

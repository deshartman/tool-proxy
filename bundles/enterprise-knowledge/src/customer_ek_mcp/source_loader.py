"""sources.yaml — declarative source list, auto-registered at boot.

The customer drops a sources.yaml next to the bundle's .env, points at it
via EK_SOURCES_YAML, and the bundle auto-registers every entry on every
boot. `register_source` is idempotent on URL, so re-running on every
restart is safe — the second register against an already-indexed source
is a no-op.

Format:

    sources:
      - url: file:///srv/docs/internal-handbook
      - url: https://drive.google.com/drive/folders/<id>
        refresh_hint: daily

`refresh_hint` is metadata only today (the controller's refresh scheduler
might consult it later). `kind` is intentionally NOT a YAML field — the
products registry's `url_match` predicates own that decision.

Failure handling (option C from the plan):
- Auth/config errors raised by storage.py at module load (bad DSN, missing
  embedder creds) fail boot before this module runs.
- Per-source fetch errors are caught here, logged with full context, and
  recorded in `ek_sources` with status='failed'. Bundle keeps coming up;
  Controller sees the failures via sources_fetch.
- A malformed sources.yaml itself fails boot — it's a config error, not
  a per-source error.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import storage

logger = logging.getLogger(__name__)


class _SourceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1)
    refresh_hint: str | None = None


class _SourcesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sources: list[_SourceEntry] = Field(default_factory=list)


@dataclass(frozen=True)
class BootstrapResult:
    indexed: list[str]
    """source_ids that were already indexed before this boot (no-op)."""

    newly_indexed: list[str]
    """source_ids registered for the first time this boot, successfully."""

    failed: list[tuple[str, str]]
    """(url, error) for each source whose register raised."""


def load_sources_yaml(path: Path | None = None) -> list[_SourceEntry]:
    """Read and validate sources.yaml. Returns empty list if no file is configured.

    Path resolution:
      1. Argument `path` (test injection).
      2. EK_SOURCES_YAML env var (production).
      3. Otherwise — return empty list (auto-register opt-in).

    Raises RuntimeError on malformed YAML or schema violations. The
    caller (typically __main__.py) lets it propagate so the bundle fails
    boot and the connector spawner readiness probe trips.
    """
    resolved = path or _resolved_path_from_env()
    if resolved is None:
        return []
    if not resolved.is_file():
        raise RuntimeError(
            f"EK_SOURCES_YAML={str(resolved)!r} is not a file. Either set "
            f"the env var to a valid path or unset it to disable auto-register."
        )

    try:
        raw = yaml.safe_load(resolved.read_text()) or {}
    except yaml.YAMLError as exc:
        raise RuntimeError(f"failed to parse {resolved}: {exc}") from exc

    try:
        parsed = _SourcesFile.model_validate(raw)
    except ValidationError as exc:
        raise RuntimeError(
            f"sources.yaml schema error in {resolved}:\n{exc}"
        ) from exc

    return parsed.sources


def bootstrap_sources(path: Path | None = None) -> BootstrapResult:
    """Validate sources.yaml and register every entry.

    This is the single-call shape — load + register together. Used by
    direct callers and tests. The two-step shape (load_sources_yaml →
    register_sources) is what __main__.py uses to do validation
    eagerly and registration in a background thread.

    Per-source exceptions are caught in register_sources. Whole-file
    errors (missing file, malformed YAML) raise from load_sources_yaml.
    """
    entries = load_sources_yaml(path)
    return register_sources(entries)


def register_sources(entries: list["_SourceEntry"]) -> BootstrapResult:
    """Register each entry via storage.register_source. Idempotent on URL.

    Per-source exceptions are caught here, persisted to ek_sources as
    status='failed' rows by storage, and reported in BootstrapResult.failed.
    The caller decides how to surface the result (log summary, push to a
    future bootstrap_status tool, etc.).

    Safe to call from a background thread: storage.register_source holds
    storage._lock, so concurrent tool calls from the controller serialize
    through the same lock. The function blocks per-source on the
    underlying reader (Drive API calls, file IO) — caller should expect
    it to take seconds-to-tens-of-seconds for a real-world source list.
    """
    if not entries:
        logger.info("sources.yaml empty or unset — skipping auto-register")
        return BootstrapResult(indexed=[], newly_indexed=[], failed=[])

    indexed: list[str] = []
    newly_indexed: list[str] = []
    failed: list[tuple[str, str]] = []

    for entry in entries:
        try:
            result = storage.register_source(url=entry.url)
        except Exception as exc:
            failed.append((entry.url, str(exc)))
            logger.warning(
                "auto-register failed url=%s err=%s", entry.url, exc,
            )
            continue

        if result.get("status") == "already_indexed":
            indexed.append(result["source_id"])
        else:
            newly_indexed.append(result["source_id"])

    logger.info(
        "auto-register complete: %d already-indexed, %d newly-indexed, %d failed",
        len(indexed), len(newly_indexed), len(failed),
    )
    return BootstrapResult(
        indexed=indexed,
        newly_indexed=newly_indexed,
        failed=failed,
    )


def _resolved_path_from_env() -> Path | None:
    raw = os.environ.get("EK_SOURCES_YAML", "").strip()
    if not raw:
        return None
    return Path(raw).expanduser()


__all__ = ["bootstrap_sources", "load_sources_yaml", "register_sources", "BootstrapResult"]

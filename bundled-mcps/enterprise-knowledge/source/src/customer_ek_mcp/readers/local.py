"""Local files reader — file:// URLs and absolute filesystem paths.

The original v1 reader. Always installed (no extra needed) — every
EK deployment can index local files.

A path may be a directory (recursed by SimpleDirectoryReader) or a single
file. Stable doc IDs of the form `file:<path>` keep the refresh diff
working: PGVectorStore.delete(ref_doc_id=...) only matches stored chunks
if the ref_doc_id is the same as when those chunks were inserted.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from urllib.parse import urlparse

from llama_index.core import SimpleDirectoryReader
from llama_index.core.schema import Document

from customer_ek_mcp.config import local_roots

KIND = "local"


def url_match(url: str) -> bool:
    """Accept absolute paths and file:// URLs.

    Refuses anything with another scheme (https://, gdrive://, etc.) so
    other products' URLs don't accidentally get routed here.
    """
    return _local_path(url) is not None


def load(url: str, kind: str | None = None) -> tuple[list[Document], str]:
    """Read documents from a local path."""
    path = _local_path(url)
    if path is None:
        raise ValueError(f"local reader cannot handle url={url!r}")
    if not os.path.exists(path):
        raise FileNotFoundError(f"local path does not exist: {path}")

    # Verify regular file or directory (no device files)
    st = os.stat(path)
    if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
        raise ValueError(f"local path is not a regular file or directory: {path}")

    if os.path.isdir(path):
        docs = SimpleDirectoryReader(input_dir=path, recursive=True).load_data()
    else:
        docs = SimpleDirectoryReader(input_files=[path]).load_data()
    _stabilize_doc_ids(docs)
    return docs, KIND


def _local_path(url: str) -> str | None:
    """Return a validated filesystem path if `url` names a local file/directory within EK_LOCAL_ROOTS, else None."""
    roots = local_roots()
    if not roots:
        return None

    raw_path: str | None = None
    if url.startswith("/"):
        raw_path = url
    else:
        parsed = urlparse(url)
        if parsed.scheme == "file":
            raw_path = parsed.path
        elif parsed.scheme == "":
            raw_path = url

    if not raw_path:
        return None

    try:
        # Canonicalize path and follow symlinks
        resolved = Path(raw_path).resolve(strict=True)
    except Exception:
        return None

    # Check if resolved path is relative to at least one allowed root
    allowed = False
    for root in roots:
        try:
            resolved.relative_to(root)
            allowed = True
            break
        except ValueError:
            continue

    if not allowed:
        return None

    return str(resolved)


def _stabilize_doc_ids(docs: list[Document]) -> None:
    """Replace SimpleDirectoryReader's auto-generated UUIDs with deterministic
    IDs based on the source file path.

    Stable doc IDs are required for the refresh diff path: PGVectorStore.delete
    (ref_doc_id=...) only matches stored chunks if the ref_doc_id is the same
    as when those chunks were inserted. Without this, every refresh would
    accumulate stale chunks in the per-source vector table.
    """
    for doc in docs:
        file_path = doc.metadata.get("file_path") or doc.metadata.get("filename")
        if file_path:
            doc.doc_id = f"file:{file_path}"

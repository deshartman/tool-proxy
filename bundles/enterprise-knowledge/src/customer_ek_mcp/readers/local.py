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
from urllib.parse import urlparse

from llama_index.core import SimpleDirectoryReader
from llama_index.core.schema import Document


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

    if os.path.isdir(path):
        docs = SimpleDirectoryReader(input_dir=path, recursive=True).load_data()
    else:
        docs = SimpleDirectoryReader(input_files=[path]).load_data()
    _stabilize_doc_ids(docs)
    return docs, KIND


def _local_path(url: str) -> str | None:
    """Return a filesystem path if `url` names a local file/directory, else None."""
    if url.startswith("/"):
        return url
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return parsed.path
    if parsed.scheme == "":
        # Bare relative path. Treat as local; SimpleDirectoryReader will
        # fail with a useful error if it doesn't exist.
        return url
    return None


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

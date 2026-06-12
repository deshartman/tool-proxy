"""Source-reader dispatch.

`pick_reader(url, kind=None)` returns the parsed `Document` list plus a
resolved `kind` tag that gets stored in `ek_sources.kind`. The kind is
informational metadata — query and refresh dispatch on `kind` so the
right reader is re-invoked on refresh.

v1 supports local files only:
- `file://` URLs and absolute filesystem paths.
- A path may be a directory (recursed by SimpleDirectoryReader) or a
  single file (SimpleDirectoryReader handles both via input_dir vs
  input_files).

Confluence and other source kinds slot in here as additional branches
without touching storage.py or the MCP tool surface.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

from llama_index.core import SimpleDirectoryReader
from llama_index.core.schema import Document


KIND_LOCAL_FILES = "local_files"


def pick_reader(url: str, kind: str | None = None) -> tuple[list[Document], str]:
    """Resolve a source URL/path to (documents, kind).

    Raises NotImplementedError for source kinds the v1 reader doesn't
    handle yet — the connector forwards the error verbatim to the
    controller so misconfiguration surfaces clearly.
    """
    path = _local_path(url)
    if path is not None:
        if not os.path.exists(path):
            raise FileNotFoundError(f"local path does not exist: {path}")
        if os.path.isdir(path):
            docs = SimpleDirectoryReader(input_dir=path, recursive=True).load_data()
        else:
            docs = SimpleDirectoryReader(input_files=[path]).load_data()
        return docs, KIND_LOCAL_FILES

    raise NotImplementedError(
        f"source kind not yet supported for url={url!r}. "
        "v1 supports local files only (file:// or absolute paths)."
    )


def _local_path(url: str) -> str | None:
    """Return a filesystem path if `url` names a local file/directory, else None."""
    if url.startswith("/"):
        return url
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return parsed.path
    if parsed.scheme == "":
        return url
    return None

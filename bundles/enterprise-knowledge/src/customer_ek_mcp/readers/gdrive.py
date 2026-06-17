"""Google Drive reader — folder URLs, two auth postures.

URL form: full `https://drive.google.com/drive/folders/<id>` (the URL you
copy from a browser tab when looking at a Drive folder). The reader
extracts the folder ID and hands it to llama-index's GoogleDriveReader.

Auth dispatch via `EK_GDRIVE_AUTH`:

  service_account
      Headless. Operator drops a service-account JSON at
      EK_GDRIVE_SERVICE_ACCOUNT_KEY (a path). The folder must be shared
      with the service account's email — Drive doesn't auto-grant access.
      Production-shape posture; the bundle never invokes a browser.

  oauth_user
      Personal Drive content. Operator runs a one-time interactive mint
      somewhere with a browser (NOT this bundle), produces a token.json,
      and points the bundle at it via EK_GDRIVE_TOKEN_PATH. The bundle
      reads the cached token; it does NOT run the browser flow itself.
      This keeps the bundle headless-safe — running an interactive OAuth
      flow inside a Type 3 stdio child would deadlock.

Lockdown discipline (mirrors embedder.py):
  - Required env vars are checked at first reader call (lazy — gdrive
    deps may be uninstalled if no Drive sources are configured).
  - Mixed-mode env (both auth blocks set) is refused.
  - Missing files raise actionable errors that point at the right env
    var to fix.

Doc IDs: stable `gdrive:<file_id>` so refresh diff works the same way
as local files. The reader populates `metadata.file_id` on each Document.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from llama_index.core.schema import Document


KIND = "gdrive"
ENV_AUTH = "EK_GDRIVE_AUTH"
ENV_SERVICE_ACCOUNT_KEY = "EK_GDRIVE_SERVICE_ACCOUNT_KEY"
ENV_TOKEN_PATH = "EK_GDRIVE_TOKEN_PATH"

DEFAULT_AUTH = "service_account"
SUPPORTED_AUTHS = {"service_account", "oauth_user"}

# Env vars that, if set under the wrong auth mode, indicate operator
# misconfiguration (two auth blocks left in the same .env). Same posture
# as embedder.py's _AZURE_ENV_VARS check.
_OAUTH_USER_ONLY_VARS = (ENV_TOKEN_PATH,)
_SERVICE_ACCOUNT_ONLY_VARS = (ENV_SERVICE_ACCOUNT_KEY,)

logger = logging.getLogger(__name__)


# Drive folder URL — extracts <id> from the canonical
# `https://drive.google.com/drive/folders/<id>?...` form.
_FOLDER_URL_RE = re.compile(
    r"^https?://drive\.google\.com/drive/(?:u/\d+/)?folders/([A-Za-z0-9_\-]+)"
)


def url_match(url: str) -> bool:
    """Accept Drive folder URLs only.

    File URLs (`/file/d/<id>/view`) and shared-drive root URLs are not
    supported by v1 — folders are the unit of registration.
    """
    return _FOLDER_URL_RE.match(url) is not None


def load(url: str, _kind: str | None = None) -> tuple[list[Document], str]:
    """Fetch documents from a Drive folder.

    Imports the gdrive deps lazily so a deployment without [gdrive]
    installed doesn't crash module load — the user only sees the
    actionable ImportError if they actually configure a Drive source.

    The `_kind` arg is part of the LoaderFn contract (refresh passes the
    stored kind back in so the right reader runs even after URL drift)
    but this loader doesn't condition on it — Drive folder URLs are
    self-describing.
    """
    folder_id = _extract_folder_id(url)
    reader = _build_reader(folder_id)
    documents = reader.load_data()
    _stabilize_doc_ids(documents)
    return documents, KIND


def _extract_folder_id(url: str) -> str:
    match = _FOLDER_URL_RE.match(url)
    if not match:
        raise ValueError(
            f"gdrive reader cannot handle url={url!r}. Expected "
            f"'https://drive.google.com/drive/folders/<id>'."
        )
    return match.group(1)


def _build_reader(folder_id: str) -> Any:
    """Construct GoogleDriveReader with the right auth payload for the env."""
    try:
        from llama_index.readers.google import GoogleDriveReader
    except ImportError as exc:
        raise ImportError(
            "Google Drive reader requires the [gdrive] extra. Install "
            "with `uv pip install -e .[gdrive]` (dev) or rebuild the "
            "bundle's image with the extra enabled."
        ) from exc

    auth_mode = os.environ.get(ENV_AUTH, DEFAULT_AUTH).strip().lower()
    if auth_mode not in SUPPORTED_AUTHS:
        raise RuntimeError(
            f"unknown {ENV_AUTH}={auth_mode!r}. Supported: "
            f"{sorted(SUPPORTED_AUTHS)}."
        )

    _refuse_mixed_mode_env(auth_mode)

    if auth_mode == "service_account":
        key_dict = _load_service_account_key()
        return GoogleDriveReader(
            folder_id=folder_id,
            service_account_key=key_dict,
            is_cloud=True,  # don't write a token.json; service account doesn't need one
        )

    # oauth_user
    user_info = _load_authorized_user_info()
    return GoogleDriveReader(
        folder_id=folder_id,
        authorized_user_info=user_info,
        is_cloud=True,  # don't refresh-and-rewrite token.json from inside the bundle
    )


def _refuse_mixed_mode_env(auth_mode: str) -> None:
    """Refuse boot if env vars from the OTHER auth mode are set.

    Two auth blocks' creds in the same .env is almost always a
    misconfiguration; we'd rather fail loudly than silently honor
    whichever one our dispatch picks.
    """
    leaked: list[str]
    if auth_mode == "service_account":
        leaked = [v for v in _OAUTH_USER_ONLY_VARS if os.environ.get(v, "").strip()]
    else:  # oauth_user
        leaked = [v for v in _SERVICE_ACCOUNT_ONLY_VARS if os.environ.get(v, "").strip()]

    if leaked:
        raise RuntimeError(
            f"{ENV_AUTH}={auth_mode!r} but env vars from the other auth "
            f"mode are also set: {leaked}. Two auth blocks' creds in one "
            f".env is almost always a misconfiguration. Pick one mode and "
            f"remove the other block from "
            f"mcp/bundled/enterprise-knowledge/.env."
        )


def _load_service_account_key() -> dict[str, Any]:
    raw = os.environ.get(ENV_SERVICE_ACCOUNT_KEY, "").strip()
    if not raw:
        raise RuntimeError(
            f"{ENV_AUTH}=service_account requires {ENV_SERVICE_ACCOUNT_KEY} "
            f"to point at a service-account JSON file. Mint one in GCP IAM, "
            f"download the JSON, and share the Drive folder with the "
            f"service account's email."
        )
    path = Path(raw).expanduser()
    if not path.is_file():
        raise RuntimeError(
            f"{ENV_SERVICE_ACCOUNT_KEY}={raw!r} is not a file."
        )
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"failed to parse service-account JSON at {path}: {exc}"
        ) from exc


def _load_authorized_user_info() -> dict[str, Any]:
    """Read a pre-minted token.json into the dict shape the reader expects.

    The bundle deliberately does NOT run the OAuth browser flow itself.
    Operators mint the token elsewhere (one-time, on a machine with a
    browser) and copy the resulting token.json into place. Reading a
    cached token is headless-safe; running the flow inside a Type 3
    stdio child would deadlock.
    """
    raw = os.environ.get(ENV_TOKEN_PATH, "").strip()
    if not raw:
        raise RuntimeError(
            f"{ENV_AUTH}=oauth_user requires {ENV_TOKEN_PATH} to point at "
            f"a pre-minted token.json. Generate it with the gdrive-mint "
            f"helper (see bundle README §'GDrive OAuth user setup'); the "
            f"bundle does NOT run the browser flow itself."
        )
    path = Path(raw).expanduser()
    if not path.is_file():
        raise RuntimeError(
            f"{ENV_TOKEN_PATH}={raw!r} is not a file. Mint it first; "
            f"see bundle README."
        )
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"failed to parse token JSON at {path}: {exc}"
        ) from exc


def _stabilize_doc_ids(docs: list[Document]) -> None:
    """Prefix each Document's doc_id with `gdrive:` for namespace separation.

    GoogleDriveReader already sets `doc.id_ = metadata['file id']` when
    that key is present, so the IDs are already stable across refreshes.
    We just prefix them so refresh diff doesn't confuse a Drive file_id
    with a local-files `file:<path>` if both source kinds ever index the
    same string by accident.
    """
    for doc in docs:
        file_id = doc.metadata.get("file id")
        if file_id:
            doc.doc_id = f"gdrive:{file_id}"

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

    Pre-filters out shortcuts, subfolders, and non-indexable types
    before handing to GoogleDriveReader. Without this filter the reader
    issues files.get_media() against shortcuts — Drive returns 403
    "Only files with binary content can be downloaded" — and the whole
    folder ingest crashes. Real Docs/PDFs/.docx alongside shortcuts
    must still index; the shortcut just shouldn't take down the run.
    """
    folder_id = _extract_folder_id(url)
    file_ids = _list_indexable_file_ids(folder_id)
    if not file_ids:
        logger.warning(
            "no indexable files in gdrive folder %s — only shortcuts, "
            "subfolders, or unsupported types found", folder_id,
        )
        return [], KIND

    reader = _build_reader(file_ids=file_ids)
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


def _build_reader(*, folder_id: str | None = None, file_ids: list[str] | None = None) -> Any:
    """Construct GoogleDriveReader with the right auth payload for the env.

    Caller passes either folder_id (legacy/no-filter path) or file_ids
    (post-filter path used by load()). They're mutually exclusive in the
    GoogleDriveReader API.
    """
    if (folder_id is None) == (file_ids is None):
        raise ValueError("exactly one of folder_id, file_ids must be provided")

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

    common: dict[str, Any] = {"is_cloud": True}
    if folder_id is not None:
        common["folder_id"] = folder_id
    else:
        common["file_ids"] = file_ids

    if auth_mode == "service_account":
        return GoogleDriveReader(
            service_account_key=_load_service_account_key(),
            **common,
        )

    # oauth_user
    return GoogleDriveReader(
        authorized_user_info=_load_authorized_user_info(),
        **common,
    )


# Mime types we won't try to download. Shortcuts have no binary content
# (Drive returns 403 "Only files with binary content can be downloaded"),
# folders aren't files, and the *.shortcut sentinel covers Drive shortcuts
# generally. Add to this list if a customer reports a new "metadata-only"
# type that's leaking through. The reader's own _mimetypes map covers the
# Google Workspace types it can export (.docx/.xlsx/.pptx); anything else
# is treated as a downloadable binary by Drive's get_media endpoint.
_SKIP_MIMETYPES: frozenset[str] = frozenset({
    "application/vnd.google-apps.shortcut",
    "application/vnd.google-apps.folder",
})


def _list_indexable_file_ids(folder_id: str) -> list[str]:
    """List the folder via the Drive API directly, return file_ids that the
    reader can actually download.

    We do this listing ourselves (instead of letting GoogleDriveReader
    discover the folder contents) so we can drop shortcuts and other
    non-downloadable types before they trigger 403s during ingest. The
    SA path the reader uses is the same as what we'd authenticate with,
    so listing-then-loading is one extra round-trip — well worth it
    given that one shortcut crashes the whole folder otherwise.

    Subfolders are skipped today (the v1 reader doesn't recurse). When
    recursion lands, this function should fan out into them.
    """
    try:
        from googleapiclient.discovery import build
        from google.oauth2 import service_account as sa_module
        from google.oauth2.credentials import Credentials
    except ImportError as exc:
        raise ImportError(
            "Google Drive reader requires the [gdrive] extra. Install "
            "with `uv pip install -e .[gdrive]` (dev) or rebuild the "
            "bundle's image with the extra enabled."
        ) from exc

    auth_mode = os.environ.get(ENV_AUTH, DEFAULT_AUTH).strip().lower()
    if auth_mode == "service_account":
        creds = sa_module.Credentials.from_service_account_info(
            _load_service_account_key(),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )
    else:
        creds = Credentials.from_authorized_user_info(
            _load_authorized_user_info(),
            scopes=["https://www.googleapis.com/auth/drive.readonly"],
        )

    svc = build("drive", "v3", credentials=creds)

    indexable: list[str] = []
    skipped: dict[str, int] = {}
    page_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken,files(id,name,mimeType)",
            "supportsAllDrives": True,
            "includeItemsFromAllDrives": True,
            "pageSize": 1000,
        }
        if page_token:
            kwargs["pageToken"] = page_token
        res = svc.files().list(**kwargs).execute()
        for f in res.get("files", []):
            mt = f.get("mimeType", "")
            if mt in _SKIP_MIMETYPES:
                skipped[mt] = skipped.get(mt, 0) + 1
                continue
            indexable.append(f["id"])
        page_token = res.get("nextPageToken")
        if not page_token:
            break

    if skipped:
        details = ", ".join(f"{n} {mt.rsplit('.', 1)[-1]}s" for mt, n in skipped.items())
        logger.info("gdrive folder %s: skipped %s", folder_id, details)
    return indexable


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
            f"mode are also set: {leaked}. Two auth blocks' creds set "
            f"simultaneously is almost always a misconfiguration. Pick one "
            f"mode and clear the other block's env vars in the controller "
            f"creds UI (prod) or inspector session-creds paste (dev)."
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

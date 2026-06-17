#!/usr/bin/env python
"""Mint a Google Drive OAuth user token.

Run this ONCE on a machine with a browser to produce the token.json
that the bundle reads at runtime. The bundle never runs the browser
flow itself — interactive auth inside a Type 3 stdio child would
deadlock.

Inputs:
  --client-secrets PATH   GCP-issued OAuth Client ID JSON. Mint at
                          https://console.cloud.google.com/apis/credentials
                          → "Create Credentials" → "OAuth client ID" →
                          Application type: "Desktop app". Download the
                          JSON; keep it secret.
  --output PATH           Where to write the resulting token.json. Set
                          EK_GDRIVE_TOKEN_PATH in the bundle's .env to
                          this same path.

Scope: drive.readonly. Matches what GoogleDriveReader uses internally
(imported from llama_index.readers.google.drive.base.SCOPES so this
script can't drift from the reader's expectations).

Usage:
    cd bundles/enterprise-knowledge && source .venv/bin/activate
    python scripts/mint-gdrive-token.py \\
        --client-secrets ~/Downloads/oauth-client.json \\
        --output ~/.config/mcp-connector/gdrive-token.json

Then add to the bundle's .env:
    EK_GDRIVE_AUTH=oauth_user
    EK_GDRIVE_TOKEN_PATH=/home/you/.config/mcp-connector/gdrive-token.json

The token refreshes itself when the bundle reads it (the reader honors
the refresh_token field). If the refresh ever fails — token revoked,
account password changed, etc. — re-run this script to mint fresh.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mint a Google Drive OAuth user token for the EK bundle.",
    )
    parser.add_argument(
        "--client-secrets",
        required=True,
        type=Path,
        help="Path to OAuth Client ID JSON downloaded from GCP Console.",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Path to write the resulting token.json (use this as EK_GDRIVE_TOKEN_PATH).",
    )
    args = parser.parse_args()

    if not args.client_secrets.is_file():
        print(f"error: --client-secrets {args.client_secrets} is not a file", file=sys.stderr)
        return 1

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
        from llama_index.readers.google.drive.base import SCOPES
    except ImportError as exc:
        print(
            f"error: missing gdrive deps ({exc}). Install with "
            f"`uv pip install -e .[gdrive]` first.",
            file=sys.stderr,
        )
        return 2

    flow = InstalledAppFlow.from_client_secrets_file(
        str(args.client_secrets), SCOPES,
    )
    creds = flow.run_local_server(port=0)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(creds.to_json())
    args.output.chmod(0o600)
    print(f"token written to {args.output} (mode 600)")
    print(f"set EK_GDRIVE_TOKEN_PATH={args.output} in the bundle's .env")
    return 0


if __name__ == "__main__":
    sys.exit(main())

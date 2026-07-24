"""Products registry — single source of truth for the per-product split.

Each product is one `Product` entry. From that one entry we derive:
  - the MCP tool name (`<id>_register`)
  - the install-extra hint shown in `ImportError` messages
  - the URL-detection predicate used by `pick_reader()`
  - the loader callable

Adding a new product = one new entry in PRODUCTS + one new module under
`readers/<id>.py`. The MCP tool list, the dispatcher, and the boot-time
bootstrap all update from that one entry.

The shape is deliberately a list of dataclasses, not plugin discovery —
five products won't justify entry-points machinery. Revisit if/when a
customer needs to ship their own reader.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from llama_index.core.schema import Document


# Loader signature — every reader module exposes a function with this
# shape. The (url, kind_hint) pair matches today's `pick_reader()` so
# the boot-time auto-register loop can drive every product the same way.
#
# kind_hint is the stored `ek_sources.kind` value passed in on refresh,
# so the reader can re-dispatch even if URL parsing has drifted between
# register and refresh time. None on first register.
LoaderFn = Callable[[str, str | None], tuple[list[Document], str]]

# URL match predicate. Receives the URL string from sources.yaml or a
# `<id>_register` tool call. Returns True if this product owns the URL.
# At most one product should match a given URL — pick_reader() picks the
# first match, but in practice the patterns are disjoint.
UrlMatchFn = Callable[[str], bool]


@dataclass(frozen=True)
class Product:
    id: str
    """Stable product identifier. Stored as ek_sources.kind. Used as the
    register-tool-name prefix and as the install-extra name."""

    register_tool_title: str
    """Human-readable display label for the <id>_register tool. Surfaced
    via MCP's top-level Tool.title and used by the controller's tool
    picker to group EK products visually (parallel to the 'Sample <Action>'
    / 'CRM <Action>' convention used by the drop-ins)."""

    register_tool_description: str
    """Human-readable text shown in the MCP tool list. Per-product because
    'fetch a Google Drive folder' reads very differently from 'index a
    local directory'."""

    register_input_schema: dict[str, Any]
    """JSON Schema for the <id>_register tool's input. Shared minimum
    shape across products: {url: string, refresh_hint?: string}. Products
    that need richer params (e.g. mime_filter for gdrive) extend it."""

    url_match: UrlMatchFn
    """Predicate: does this URL belong to this product?"""

    load: LoaderFn
    """Reader entry point. Imported lazily by the wrapper in readers/<id>.py
    so an uninstalled `[<id>]` extra doesn't crash module load."""


def _common_register_input_schema() -> dict[str, Any]:
    """Default input schema for <id>_register tools.

    Same shape as the original sources_register: {url, refresh_hint?}.
    A product can override it in its own Product entry if it needs
    additional params (e.g. mime_filter for gdrive). The dispatcher in
    __main__.py only requires `url` to be present.
    """
    return {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Source URL to ingest.",
            },
            "refresh_hint": {
                "type": "string",
                "description": "Suggested refresh cadence (e.g. 'daily'); metadata only.",
            },
        },
        "required": ["url"],
        "additionalProperties": False,
    }


def _build_local_product() -> Product:
    """Construct the local-files Product entry.

    Wrapped in a function so the lazy import of readers.local doesn't
    happen at module-import time of products.py — keeps circular imports
    impossible (readers/* import from products would have to wait for
    PRODUCTS, but PRODUCTS calls into readers/*).
    """
    from .readers import local as local_reader

    return Product(
        id="local",
        register_tool_title="Register Source: Local Files",
        register_tool_description=(
            "Index a local file or directory. Path can be absolute "
            "(/path/to/folder) or a file:// URL. Directories are recursed."
        ),
        register_input_schema=_common_register_input_schema(),
        url_match=local_reader.url_match,
        load=local_reader.load,
    )


def _build_gdrive_product() -> Product:
    """Construct the Google Drive Product entry.

    Same lazy-import shape as local. The reader module imports the
    gdrive SDK only inside its `load()` body, so this construction is
    safe even when the [gdrive] extra is uninstalled — the ImportError
    only fires if a Drive URL is actually registered.
    """
    from .readers import gdrive as gdrive_reader

    return Product(
        id="gdrive",
        register_tool_title="Register Source: Google Drive",
        register_tool_description=(
            "Index a Google Drive folder. URL is the full "
            "https://drive.google.com/drive/folders/<id> form copied "
            "from a browser tab. Requires the [gdrive] install extra and "
            "EK_GDRIVE_AUTH + provider env vars (see .env.example)."
        ),
        register_input_schema=_common_register_input_schema(),
        url_match=gdrive_reader.url_match,
        load=gdrive_reader.load,
    )


def _build_products() -> list[Product]:
    """Assemble the registry. New products append here.

    Order matters only for `pick_product()` tie-breaking; in practice the
    url_match predicates are disjoint.
    """
    return [_build_local_product(), _build_gdrive_product()]


PRODUCTS: list[Product] = _build_products()
PRODUCT_BY_ID: dict[str, Product] = {p.id: p for p in PRODUCTS}


def pick_product(url: str) -> Product:
    """Find the product whose `url_match` predicate accepts `url`.

    Raises ValueError if no product matches — the URL doesn't belong to
    any wired reader. The error message lists the products that ARE wired
    so the operator knows what's available.
    """
    for product in PRODUCTS:
        if product.url_match(url):
            return product
    available = ", ".join(p.id for p in PRODUCTS)
    raise ValueError(
        f"no product matches url={url!r}. Wired products: {available}. "
        f"Other source kinds (confluence, web, sharepoint, notion) are "
        f"parked and not yet shipped."
    )


def get_product(product_id: str) -> Product:
    """Look up by id. Raises KeyError-with-context for unknown ids."""
    try:
        return PRODUCT_BY_ID[product_id]
    except KeyError as exc:
        available = ", ".join(p.id for p in PRODUCTS)
        raise KeyError(
            f"unknown product_id {product_id!r}. Wired products: {available}."
        ) from exc

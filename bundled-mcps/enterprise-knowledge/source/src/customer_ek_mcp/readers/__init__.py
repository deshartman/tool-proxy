"""Source-reader dispatch.

Each product gets its own reader module under this package. The dispatcher
consults `products.PRODUCTS` — `pick_reader()` matches the URL against
each product's `url_match` predicate and dispatches to that product's
`load()`.

A registered source's `kind` (= product id) is stored on `ek_sources`
so refresh can re-dispatch to the same reader without re-parsing the URL.
"""

from __future__ import annotations

from llama_index.core.schema import Document

from .. import products


def pick_reader(url: str, kind: str | None = None) -> tuple[list[Document], str]:
    """Resolve a source URL/path to (documents, kind).

    On register: kind is None; the matching product is chosen via
    `url_match` and its id becomes the kind.

    On refresh: kind is the stored `ek_sources.kind`; we look up the
    product by id directly so URL drift doesn't change which reader runs.
    """
    if kind is not None:
        product = products.get_product(kind)
    else:
        product = products.pick_product(url)
    return product.load(url, kind)


__all__ = ["pick_reader"]

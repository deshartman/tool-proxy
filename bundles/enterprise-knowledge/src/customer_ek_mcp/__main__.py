"""Entrypoint — exposes EK tools over MCP stdio.

Tool surface (registry-driven):
  - <id>_register   per product in `products.PRODUCTS`. Today: local_register.
                    Adds gdrive_register in Phase 4b, and so on.
  - knowledge_query, sources_refresh, sources_fetch — generic, source-id
                    keyed. Source-id is opaque; the procedure asking for
                    chunks doesn't need to know which product produced them.

Boot-time auto-register: just before `stdio_server()` opens, we run
`source_loader.bootstrap_sources()` which reads sources.yaml (if
EK_SOURCES_YAML is set) and calls `storage.register_source` for each
entry. Per-source failures are persisted to ek_sources with
status='failed' and surface to the Controller via sources_fetch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from . import __version__, products, source_loader, storage

logger = logging.getLogger(__name__)


REGISTER_SUFFIX = "_register"


server: Server = Server(name="enterprise-knowledge", version=__version__)

# Module-level reference to the background bootstrap task, so the asyncio
# event loop doesn't garbage-collect it mid-run. Set in _run() once we
# know there are entries to register; stays alive for the lifetime of the
# bundle process.
_bootstrap_task: asyncio.Task[Any] | None = None


def _register_tool_for(product: "products.Product") -> Tool:
    return Tool(
        name=f"{product.id}{REGISTER_SUFFIX}",
        description=product.register_tool_description,
        inputSchema=product.register_input_schema,
    )


def _generic_tools() -> list[Tool]:
    return [
        Tool(
            name="knowledge_query",
            description=(
                "Vector lookup against an indexed source. Returns top-K "
                "chunks with citations. Pure retrieval — no fetching or "
                "embedding happens at query time except for the query "
                "string itself. source_id is opaque; you don't need to "
                "know which product produced it."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "query": {"type": "string"},
                    "k": {"type": "integer", "minimum": 1, "default": 5},
                },
                "required": ["source_id", "query"],
                "additionalProperties": False,
            },
        ),
        Tool(
            name="sources_refresh",
            description=(
                "Re-fetch a source, diff against the existing index, and "
                "re-embed only changed chunks. Reader is selected from "
                "the source's stored kind, so this works across all "
                "products. Set force=true to re-embed every chunk."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "force": {
                        "type": "boolean",
                        "default": False,
                        "description": "Re-embed every chunk regardless of diff.",
                    },
                },
                "required": ["source_id"],
                "additionalProperties": False,
            },
        ),
        Tool(
            name="sources_fetch",
            description=(
                "List every registered source with its kind, status, and "
                "last error if any. Failed sources (boot-time auto-register "
                "errors, refresh errors) are returned alongside successful "
                "ones — filter by `status` or `kind` on the controller side."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        ),
    ]


@server.list_tools()
async def _list_tools() -> list[Tool]:
    return [
        _register_tool_for(p) for p in products.PRODUCTS
    ] + _generic_tools()


@server.call_tool()
async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    result: Any
    if name.endswith(REGISTER_SUFFIX):
        product_id = name[: -len(REGISTER_SUFFIX)]
        product = products.get_product(product_id)
        url = arguments["url"]
        if not product.url_match(url):
            raise ValueError(
                f"{name} cannot handle url={url!r}. The URL doesn't match "
                f"this product's expected shape — did you mean a different "
                f"<id>_register tool?"
            )
        result = storage.register_source(url=url)
    elif name == "knowledge_query":
        result = storage.query(
            source_id=arguments["source_id"],
            query_text=arguments["query"],
            k=int(arguments.get("k", 5)),
        )
    elif name == "sources_refresh":
        result = storage.refresh(
            source_id=arguments["source_id"],
            force=bool(arguments.get("force", False)),
        )
    elif name == "sources_fetch":
        result = storage.list_sources()
    else:
        raise ValueError(f"unknown tool: {name}")
    return [TextContent(type="text", text=json.dumps(result))]


async def _run() -> None:
    # Validate sources.yaml synchronously — a malformed file or a missing
    # EK_SOURCES_YAML target should fail boot fast, before stdio_server()
    # opens, so the connector spawner readiness probe surfaces the error.
    # Per-source registration runs in a background thread *after* stdio
    # is open, so a slow source (Drive 403 retries, network hiccup) can't
    # block the connector's tunnel dial. register_source holds storage._lock,
    # so any tool call that arrives mid-bootstrap serializes safely.
    source_entries = source_loader.load_sources_yaml()
    if source_entries:
        global _bootstrap_task
        _bootstrap_task = asyncio.create_task(
            asyncio.to_thread(source_loader.register_sources, source_entries),
        )

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()

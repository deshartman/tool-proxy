"""Entrypoint — exposes the four EK tools over MCP stdio.

Step 2 wires tools directly through the `mcp` Python SDK so the bundle is
runnable without LlamaIndex. Step 4 will replace each tool body with a
LlamaIndex Workflow wrapped via
`llama_index.tools.mcp.utils.workflow_as_mcp`; the wire shape (tool names,
input schemas, return values) is identical so the controller-side contract
doesn't move.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from . import __version__, storage


server: Server = Server(name="enterprise-knowledge", version=__version__)


@server.list_tools()
async def _list_tools() -> list[Tool]:
    return [
        Tool(
            name="ek_register_source",
            description=(
                "Synchronously fetch, parse, chunk, embed, and index a "
                "document URL. Returns a stable source_id. Idempotent on URL."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Source URL to ingest"},
                    "kind": {
                        "type": "string",
                        "description": "Source kind (auto-detected from URL if absent)",
                    },
                    "refresh_hint": {
                        "type": "string",
                        "description": "Suggested refresh cadence (e.g. 'daily'); metadata only",
                    },
                },
                "required": ["url"],
                "additionalProperties": False,
            },
        ),
        Tool(
            name="ek_query",
            description=(
                "Vector lookup against an indexed source. Returns top-K chunks "
                "with citations. Pure retrieval — no fetching or embedding "
                "happens at query time except for the query string itself."
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
            name="ek_refresh",
            description=(
                "Re-fetch a source, diff against the existing index, and "
                "re-embed only changed chunks. Background-safe; runs from the "
                "controller's refresh scheduler."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "source_id": {"type": "string"},
                    "force": {
                        "type": "boolean",
                        "default": False,
                        "description": "Re-embed every chunk regardless of diff",
                    },
                },
                "required": ["source_id"],
                "additionalProperties": False,
            },
        ),
        Tool(
            name="ek_list_sources",
            description="List every indexed source with its metadata.",
            inputSchema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        ),
    ]


@server.call_tool()
async def _call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    result: Any
    if name == "ek_register_source":
        result = storage.register_source(url=arguments["url"])
    elif name == "ek_query":
        result = storage.query(
            source_id=arguments["source_id"],
            query_text=arguments["query"],
            k=int(arguments.get("k", 5)),
        )
    elif name == "ek_refresh":
        result = storage.refresh(
            source_id=arguments["source_id"],
            force=bool(arguments.get("force", False)),
        )
    elif name == "ek_list_sources":
        result = storage.list_sources()
    else:
        raise ValueError(f"unknown tool: {name}")
    return [TextContent(type="text", text=json.dumps(result))]


async def _run() -> None:
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

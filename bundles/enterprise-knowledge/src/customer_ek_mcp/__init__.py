"""Enterprise Knowledge MCP — LlamaIndex-backed RAG over pgvector.

v1 supports local files (file:// URLs and absolute paths). The four MCP
tools — sources_register, knowledge_query, sources_refresh, sources_fetch —
are wired through the bare `mcp` SDK in __main__.py and dispatch to
storage.py, which sits over LlamaIndex + PGVectorStore + a local
HuggingFace embedder.

See ../../.claude/plans/EK-IMPLEMENTATION.md for the full plan.
"""

__version__ = "0.1.0"

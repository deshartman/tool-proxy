"""Enterprise Knowledge MCP — stub backend.

Step 2 of LLAMA-INDEX.md ships a runnable shape with placeholder data so the
controller-side hydration / scheduler / schema work has a stable contract to
build against. Step 4 swaps the stub for a real LlamaIndex backend
(VectorStoreIndex + pgvector/Chroma + local embedder).
"""

__version__ = "0.0.1"

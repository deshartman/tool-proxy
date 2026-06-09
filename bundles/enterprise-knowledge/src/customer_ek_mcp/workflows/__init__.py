"""LlamaIndex Workflow definitions — populated in step 4 of LLAMA-INDEX.md.

In step 4 each MCP tool becomes a `Workflow` class wrapped via
`llama_index.tools.mcp.utils.workflow_as_mcp`:

  workflows/query.py     — EnterpriseKnowledgeQueryWorkflow
  workflows/register.py  — RegisterSourceWorkflow
  workflows/refresh.py   — RefreshSourceWorkflow
  workflows/list.py      — ListSourcesWorkflow

Step 2 ships the tool surface inline through the bare `mcp` SDK
(`__main__.py`); this directory exists so step 4 has a fixed home to
land in.
"""

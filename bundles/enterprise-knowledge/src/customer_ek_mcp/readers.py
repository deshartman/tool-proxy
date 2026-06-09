"""Source-reader dispatch — lands in step 4.

Per LLAMA-INDEX.md, this module owns `pick_reader(url, kind=None)` which
dispatches by URL/kind to the right LlamaIndex reader (HTTP, PDF, DOCX,
SharePoint, Confluence, Notion, …). Step 2 doesn't fetch anything — the
stub `storage.register_source` synthesizes placeholder chunks instead — so
this module is intentionally empty for now.

Naming kept here so step 4's import surface is stable.
"""

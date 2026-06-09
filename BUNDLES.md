# Bundles in this connector image

This file lists the [Type 3 bundled MCPs](CLAUDE.md) that the connector image at the current commit is built against. Bundle source lives in the sibling repo [`mcp-shim-bundled/`](../mcp-shim-bundled/); this is a manifest of which bundles + which versions ship in the image.

| Bundle | Source | Version | Entrypoint (in image) | `.env` stub |
|---|---|---|---|---|
| `enterprise-knowledge` | [`mcp-shim-bundled/enterprise-knowledge/`](../mcp-shim-bundled/enterprise-knowledge/) | local source (step 2 stub backend) | `/opt/bundled-mcps/enterprise-knowledge/.venv/bin/customer-ek-mcp` | [`mcp/bundled/enterprise-knowledge/.env.example`](mcp/bundled/enterprise-knowledge/.env.example) |

## Authoritative registry

[`packages/connector/src/config.ts`](packages/connector/src/config.ts) exports `BUNDLED_MCPS` — the runtime registry the connector consults when resolving a yaml `bundled:` entry. This file is documentation; the registry is code.

## Bumping a bundle version

1. Bump the version in `mcp-shim-bundled/<bundle>/pyproject.toml` (or `package.json`).
2. Publish the artifact (PyPI wheel for Python bundles, npm tarball for Node bundles).
3. In `mcp-shim`, update the `BUNDLED_MCPS` entry's pinned version + this file.
4. Rebuild the connector image.

While bundles are still installed from local source (today), step 1 is just an update in the sibling repo's working tree and the rebuild picks up whatever is checked out.

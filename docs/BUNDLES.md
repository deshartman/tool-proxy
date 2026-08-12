# Bundles in this connector image

This file lists the [Type 3 bundled MCPs](../CLAUDE.md) that the connector image at the current commit is built against. Bundle source lives in [`bundles/<name>/`](../bundled-mcps/) — a sibling tree to the connector itself, deliberately separate from `mcp/` so the runtime image carries only the *installed* venv (`/opt/bundled-mcps/<name>/.venv/`), not the build inputs (`pyproject.toml`, `src/`, `migrations/`).

| Bundle | Source | Entrypoint (in image) | `.env` stub |
|---|---|---|---|
| `enterprise-knowledge` | [`bundled-mcps/enterprise-knowledge/source/`](../bundled-mcps/enterprise-knowledge/source/) | `/opt/bundled-mcps/enterprise-knowledge/.venv/bin/customer-ek-mcp` | [`bundled-mcps/enterprise-knowledge/.env.example`](../bundled-mcps/enterprise-knowledge/.env.example) |

## What ships vs. what doesn't

| Path | In runtime image? |
|---|---|
| `bundles/<name>/pyproject.toml`, `src/`, `migrations/` | **No** — read by `pip` in the build stage; never lands in the runtime layer |
| `/opt/bundled-mcps/<name>/.venv/` | **Yes** — the installed bundle is what runs |
| `mcp/bundled/<name>/.env.example` | **Yes** — customer copies it to `.env` for credentials |

## Authoritative registry (Type 3 only)

[`connector/src/config.ts`](../connector/src/config.ts) exports `BUNDLED_MCPS` — the runtime registry the connector consults when resolving a yaml `bundled:` entry. This file is documentation; the registry is code.

> **Type 1** (customer-authored drop-ins) and **Type 2** (controller-pushed 3rd-party MCPs) do **not** flow through `BUNDLED_MCPS`. Type 1 drop-ins are auto-discovered from `MCP_DROPIN_DIR` at boot or via the **Refresh local MCPs** action; Type 2 MCPs arrive over the WSS tunnel as `mcp-config-snapshot` / `mcp-config-delta` frames and live in connector RAM only. See [`MCP-PROTOCOL.md`](MCP-PROTOCOL.md) for the wire-format details.

## Adding or updating a bundle

1. Edit `bundles/<bundle>/` source.
2. Bump the version in `bundles/<bundle>/pyproject.toml` (or `package.json` for a Node bundle).
3. If the bundle isn't yet registered, add an entry to `BUNDLED_MCPS` in [`connector/src/config.ts`](../connector/src/config.ts) and to this file.
4. Rebuild the connector image (`./scripts/build-image.sh`). The Dockerfile reads `bundles/<name>/` directly; no separate publish step.

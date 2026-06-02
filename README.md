# mcp-shim-connector

A customer-side **MCP connector**: dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests to the right local server.

The controller is **outside this repo**. This repo is the customer side only.

## Layout

```
packages/
  connector/            customer-side process: tunnel client + dispatcher + inspector UI
  sample-mcp-server/    tiny stub MCP server (echo, now, slow_echo) used for verification
scripts/
  run-connector.sh      boots sample-mcp-server + connector
```

## Quick start

```bash
npm install
npm run build

# First-time setup:
cp packages/connector/config/connector-a.yaml.example packages/connector/config/connector-a.yaml
cp packages/connector/config/connector-a.env.example  packages/connector/config/connector-a.env
# Edit connector-a.yaml: set tunnel.controller_url and tunnel.connector_id.

./scripts/run-connector.sh
```

Open the inspector UI at <http://localhost:9090/>.

The inspector shows:
- live WS state (connecting / open / closed)
- the `ToolManifest` and per-tool allow/deny verdicts
- every frame in/out
- a **Reconnect** button that re-reads the YAML and redials

To pick up changes to `mcp_servers`, restart the script (those connections are made at boot).

## What's load-bearing

- **Outbound only.** The connector opens no inbound ports for the tunnel.
- **Trust boundary is per MCP server, not per tool.** Every tool a configured MCP server exposes is forwarded — pick which servers run carefully.
- **No LLM, no agent loop, no document handling.** This is a tool dispatcher with policy.

See [CLAUDE.md](CLAUDE.md) and [packages/connector/README.md](packages/connector/README.md) for details.

## Reference branch

The earlier proof-of-concept (in-shim LLM agent, document adapters, `can_answer` / `ask_procedure` tool surface) is preserved on the `poc-testing` branch.

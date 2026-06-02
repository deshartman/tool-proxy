# mcp-shim-connector

A customer-side **MCP connector**: dials out to a controller URL via WSS, advertises locally-installed MCP servers as a `ToolManifest`, and dispatches inbound `tools/call` requests to the right local server.

The controller is **outside this repo**. This repo is the customer side only.

## Layout

```
packages/
  connector/                 the customer-side process (only thing that ships)
examples/
  sample-mcp-server/         standalone demo MCP server (now, slow_echo, uuid, weather)
  twilio-mcp-server/         standalone demo MCP server wrapping Twilio APIs
docs/deploy/                 per-cloud deployment guides (AWS Fargate, Azure Container Apps, GCP GKE)
scripts/
  run-connector.sh           boots one connector per examples/<server>/, all dialing CONTROLLER_URL
  build-image.sh             builds the multi-arch OCI image
```

Each `examples/<server>/` directory carries its own `connector.yaml{,.example}` and `.env{,.example}`. The repo-root `.env` carries only `CONTROLLER_URL` (genuinely shared). The connector binary itself is one thing, run once per pairing in dev, once per `connector_id` container in prod.

## Quick start (development)

```bash
# Connector (workspace).
npm install
npm run build

# Demo MCP servers (standalone — install + build each one you want to use).
(cd examples/sample-mcp-server && npm install && npm run build)
(cd examples/twilio-mcp-server && npm install && npm run build)

# Repo-root .env: just CONTROLLER_URL.
cp .env.example .env

# Per-pairing env + YAML — repeat for each examples/<server>/.
cp examples/sample-mcp-server/.env.example          examples/sample-mcp-server/.env
cp examples/sample-mcp-server/connector.yaml.example examples/sample-mcp-server/connector.yaml
cp examples/twilio-mcp-server/.env.example          examples/twilio-mcp-server/.env
cp examples/twilio-mcp-server/connector.yaml.example examples/twilio-mcp-server/connector.yaml

./scripts/run-connector.sh
```

Inspector UIs: <http://localhost:9090/> (sample), <http://localhost:9091/> (twilio).

The inspector shows:
- live WS state (connecting / open / closed)
- the `ToolManifest` and an "Available Tools" list (all discovered tools are Ready)
- every frame in/out
- a **Reconnect** button that re-reads the YAML and redials

`run-connector.sh` auto-skips a pairing whose `.env` lists `TWILIO_ACCOUNT_SID=` empty, so the script still boots if you don't have Twilio creds set.

To pick up changes to `mcp_servers`, restart the script (those connections are made at boot).

## CLI

The connector is also a CLI:

```
mcp-connector start         run the connector (default)
mcp-connector init          interactive YAML wizard (uses tools/list as confirmation)
mcp-connector discover      print tools/list per configured server, then exit
mcp-connector version       print the connector version
```

## Production deployment

See [docs/deploy/README.md](docs/deploy/README.md) and the per-cloud guides:
[AWS Fargate](docs/deploy/aws-fargate.md), [Azure Container Apps](docs/deploy/azure-container-apps.md),
[GCP GKE](docs/deploy/gcp-gke.md).

## What's load-bearing

- **Outbound only.** The connector opens no inbound ports for the tunnel.
- **Trust boundary is per MCP server, not per tool.** Every tool a configured MCP server exposes is forwarded — pick which servers run carefully.
- **No LLM, no agent loop, no document handling.** This is a tool dispatcher with policy.

See [CLAUDE.md](CLAUDE.md) and [packages/connector/README.md](packages/connector/README.md) for details.

## Reference branch

The earlier proof-of-concept (in-shim LLM agent, document adapters, `can_answer` / `ask_procedure` tool surface) is preserved on the `poc-testing` branch.

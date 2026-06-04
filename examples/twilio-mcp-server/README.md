# Twilio MCP server (Type 1 example)

Type 1 MCP that wraps a few Twilio APIs. The connector spawns this as a
child process via `tsx server.ts` — there's no build step and no port to
pick. Used to demonstrate that the connector treats Twilio's APIs no
differently than any other customer-side MCP.

The `twilio` SDK lives only in this folder so it doesn't bloat the
connector image's `node_modules`.

## Tools

| Tool | Description | Cost |
|---|---|---|
| `lookup_phone_number({phone_number})` | Twilio Lookup v2 — validate an E.164 number, return carrier info | free |
| `list_recent({kind, limit?})` | Last N calls or messages on the account | free |
| `send_sms({to, body, from?})` | Send an SMS via Programmable Messaging | **incurs charges** |

## Setup

```bash
# From the repo root.
npm install                              # workspace install (installs tsx for the connector spawner)
(cd examples/twilio-mcp-server && npm install)  # twilio SDK lives here, not in the workspace

cp examples/twilio-mcp-server/.env.example examples/twilio-mcp-server/.env
# Fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
```

The entry already exists in `packages/connector/connector.yaml.example`:

```yaml
- name: twilio
  transport: http
  dir: ../../examples/twilio-mcp-server
```

`./scripts/start-connector.sh` from the repo root will boot the connector,
which in turn spawns this server at an auto-assigned port and dials the
tunnel. The first boot registers itself with the controller using the
`tunnel.name` in `packages/connector/connector.yaml`. The inspector at
<http://localhost:9090/> shows `twilio.lookup_phone_number`,
`twilio.list_recent`, and `twilio.send_sms`.

## Notes

- Real Twilio infrastructure would call these APIs in-process, not through
  an external MCP server. This example exists to show the connector path,
  not to recommend an architecture.
- `TWILIO_AUTH_TOKEN` is the raw account auth token. For production usage
  prefer an API Key + Secret pair (`twilio(sid, secret, { accountSid })`).
  Out of scope for the demo.
- The connector loads `examples/twilio-mcp-server/.env` into *this child's*
  process only — `TWILIO_AUTH_TOKEN` does not reach other MCP children.

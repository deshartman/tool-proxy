# Twilio MCP server (Type 1 example)

Type 1 MCP that wraps a few Twilio APIs. The connector spawns this as a
child process via `tsx server.ts` — there's no build step and no port to
pick. Used to demonstrate that the connector treats Twilio's APIs no
differently than any other customer-side MCP.

The `twilio` SDK lives only in this folder so it doesn't bloat the
connector image's `node_modules`.

## Tools

Tools have plain names (no `twilio_` prefix). The cloud-side qualifier is
`${author}.${serverName}.${toolName}` — for this MCP that resolves to
`twilio.apis.<tool>`, which flattens to e.g. `twilio_apis_messages_create`
on OpenAI's tool surface. Adding a `twilio_` tool prefix on top of that
would stutter (`twilio_apis_twilio_messages_create`).

| Tool | Description | Cost |
|---|---|---|
| `messages_create({channel, to, from?, messagingServiceSid?, body?, contentSid?, ...})` | Send a message via SMS / WhatsApp / RCS (caller must supply either `from` or `messagingServiceSid`) | **incurs charges** |
| `messages_fetch({sid})` | Look up a message by SID | free |
| `messaging_services_fetch({sid})` | Inspect a Messaging Service's config | free |
| `content_templates_fetch({sid})` | Inspect a Content template (HXxxxx) for use with `messages_create.contentSid` | free |
| `calls_create({to, from, twiml?, url?})` | Place an outbound voice call | **incurs charges** |
| `calls_fetch({sid})` | Look up a call by SID | free |
| `verify_send({to, channel, serviceSid})` | Send an OTP via Verify | **incurs charges** |
| `verify_check({to, code, serviceSid})` | Validate an OTP a user submitted | free |
| `verify_services_fetch({sid})` | Inspect a Verify Service's config | free |
| `lookups_fetch({phone_number})` | Twilio Lookup v2 — validate a number | free |

## Setup

```bash
# From the repo root.
npm install                              # workspace install (installs tsx for the connector spawner)
(cd mcp/bundled/twilio && npm install)   # twilio SDK lives here, not in the workspace

cp mcp/bundled/twilio/.env.example mcp/bundled/twilio/.env
# Fill in TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.
# Plus SENDGRID_API_KEY if you'll use the email_* tools.
# Operational values (from numbers, service SIDs, sender emails) are
# caller-supplied per tool call — they no longer come from .env.
```

The entry already exists in `packages/connector/connector.yaml.example`:

```yaml
- name: apis
  transport: http
  dir: ../../mcp/bundled/twilio
```

`./scripts/start-connector.sh` from the repo root will boot the connector,
which in turn spawns this server at an auto-assigned port and dials the
tunnel. The first boot registers itself with the controller using the
`tunnel.name` in `packages/connector/connector.yaml`. The inspector at
<http://localhost:9090/> shows the `apis.*` tools (server name = `apis`,
folder = `mcp/bundled/twilio`).

## Notes

- Real Twilio infrastructure would call these APIs in-process, not through
  an external MCP server. This example exists to show the connector path,
  not to recommend an architecture.
- The bundle is AuthToken-only. API Key / Secret was previously supported
  but removed to keep auth aligned with the controller's Twilio-bundled
  auto-fill (see [`docs/MCP-PROTOCOL.md`](../../../docs/MCP-PROTOCOL.md)
  "Twilio-bundled auto-fill"). For revocable per-service credentials, mint a
  scoped subaccount and use its AuthToken.
- The connector loads `mcp/bundled/twilio/.env` into *this child's* process
  only — credentials do not reach other MCP children.

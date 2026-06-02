# Twilio MCP server (example)

Standalone MCP server that wraps a few Twilio APIs as MCP tools. Used to
demonstrate that the connector treats Twilio's APIs no differently than any
other customer-side MCP — it's a peer of the bundled `sample-mcp-server`.

**Not** a workspace of the connector repo. The `twilio` SDK lives only here so
it doesn't bloat the connector image.

## Tools

| Tool | Description | Cost |
|---|---|---|
| `lookup_phone_number({phone_number})` | Twilio Lookup v2 — validate an E.164 number, return carrier info | free |
| `list_recent({kind, limit?})` | Last N calls or messages on the account | free |
| `send_sms({to, body, from?})` | Send an SMS via Programmable Messaging | **incurs charges** |

## Run it

```bash
cd examples/twilio-mcp-server
npm install
npm run build

cp .env.example .env
# Fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (used by send_sms).

set -a; source .env; set +a
npm start
# [twilio-mcp] listening on http://localhost:7200/mcp (tools: send_sms, lookup_phone_number, list_recent)
```

## Wire it to the connector

Add to your connector's `connector.yaml`:

```yaml
mcp_servers:
  - name: twilio
    transport: http
    endpoint: http://localhost:7200/mcp
    timeout_ms: 5000
```

Restart the connector. The inspector at <http://localhost:9090/> should now
show `twilio.lookup_phone_number`, `twilio.list_recent`, and `twilio.send_sms`
alongside whatever else you have configured.

## Notes

- Real Twilio infrastructure would call these APIs in-process, not through an
  external MCP server. This example exists to show the connector path, not to
  recommend an architecture.
- `TWILIO_AUTH_TOKEN` is the raw account auth token. For production usage
  prefer an API Key + Secret pair (`twilio(sid, secret, { accountSid })`).
  Out of scope for the demo.

# crm — demo drop-in

Restored 2026-07-27 from git history (originally deleted in commit `b53329b`,
"refactor: split reference material into examples/", 2026-07-25). This tree
sits alongside `examples/demos/sample/` as reference material — it is **not**
auto-loaded by the connector.

Demo MCP server backing the caller-facing agent flows (identify → refund,
identify → reschedule). Thin client over the mock customer service at
[`../../mock-backend/`](../../mock-backend/) — no real backend, no real
refunds, no real notifications.

## Shape

**Type 1 drop-in.** Folder ships `tools/`, `prompts/`, `resources/` and a
per-MCP `.env.example`. No `server.ts`, no `package.json`, no yaml entry — the
connector's drop-in scanner ([`connector/src/dropin.ts`](../../../connector/src/dropin.ts))
discovers the folder at boot and the synthesized child runtime
([`connector/src/sdk/dropin-runner.ts`](../../../connector/src/sdk/dropin-runner.ts))
wires everything into one MCP child process. Folder name (`crm`) becomes the
MCP name.

## Surface

### Tools

| Tool | Role | Purpose |
|------|------|---------|
| `get_customer`       | identity lookup | Returns name / surname / phone / email keyed by phone. No order history. |
| `get_recent`         | hydration       | Fires server-side before the LLM call. Returns the customer's most recent orders keyed by phone. |
| `issue_refund`       | side-effect     | Called by the BYO-LLM mid-conversation when it decides the order qualifies. In-memory ledger keyed by `orderId` for idempotency. |
| `get_appointment`    | calendar lookup | Returns the customer's next upcoming appointment keyed by phone, or `{ error: "no_appointment" }`. |
| `check_availability` | calendar query  | Validates a candidate slot. Returns `{ available, reason?, daysFromNow, isSameDay, technician, suggestions[] }`. |
| `update_appointment` | side-effect     | Reschedules an appointment to a new start. Returns the updated appointment or a 409 error envelope. |
| `notify_agent`       | side-effect     | Sends an internal-channel notification to the technician. Pure mock — logs + returns a delivery receipt. |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `identify_caller`       | Session bootstrap — loads profile + recent orders BEFORE greeting the caller. |
| `handle_refund_request` | Refund flow — identify the order, confirm amount, issue refund, escalate. |
| `book_appointment`      | Booking / reschedule flow with >30-day and same-day edge-case handling. |

### Resources

| Resource | URI | Purpose |
|----------|-----|---------|
| `recent_lookups` | `crm://lookups/recent` | In-process list of recently-looked-up customer phones (populated by `get_customer` and `get_recent`, capped at 16, newest first). Restart wipes it. |

## Installing this drop-in

`examples/demos/crm/` is reference — the connector does not read from
`examples/` at runtime. Two ways to activate it:

### A. Dev — copy into the runtime drop-in dir

```bash
cp -r examples/demos/crm customer-mcps/crm
```

`customer-mcps/*` is gitignored (that's a runtime mount point, not a source
tree), so the copy stays local to your working tree.

### B. Prod — ship in the connector image

Add a line to `connector/Dockerfile` after the existing `bundled-mcps` copy,
mirroring what `sample` already does:

```dockerfile
COPY examples/demos/crm bundled-mcps/crm
```

The drop-in scanner picks it up on next boot. Not gated (bundle path).

## Deploying the mock backend

The crm tools call the mock backend at `${MOCK_CUSTOMERS_URL}`. Deploy the
mock first (or override the env var to point somewhere else).

### Local dev

```bash
cd examples/mock-backend
npm install && npm run start
# Listens on http://localhost:7400 by default.
```

Then boot the connector:

```bash
MOCK_CUSTOMERS_URL=http://localhost:7400 ./scripts/start-connector.sh
```

### Fly.io

Use the built-in scaffold to emit a private-only Fly app for the mock:

```bash
mcp-connector deploy init --target fly-mock --name acme-mock
fly deploy --app acme-mock --config examples/mock-backend/fly.toml
```

Then set the connector's `MOCK_CUSTOMERS_URL` secret to the mock's private
address:

```bash
fly secrets set --app <CONNECTOR-APP> \
  MOCK_CUSTOMERS_URL="http://acme-mock.internal:7400"
```

The Fly deploy shape is private-only — no public IP, no `[[services]]`, no
`[http_service]`. Sibling apps in the same Fly org reach it via `.internal`.

## Demo data

Seeded in [`../../mock-backend/data.ts`](../../mock-backend/data.ts):

| `customer_phone` | Name | Notes |
|---|---|---|
| `+15551239999` | Dana Demo | 3 orders (delivered, shipped, pending) |
| `+14155550101` | Alice Anderson | `ord_42` — delivered, ~16d, refund-eligible |
| `+14155550102` | Bob Brown | `ord_77` — delivered, ~47d, fails 30-day window |
| `+14155550103` | Carol Chen | `ord_91` — pending, fails status gate |
| (email `purchaser@example.com`) | Pat Purchaser | `ord_gift_5` — gift order edge case |

Appointment calendar (seeded in [`../../mock-backend/calendar.ts`](../../mock-backend/calendar.ts))
lives alongside the customer data — one technician, one open appointment per
seeded customer.

## Wire-format tool names

Through the controller, tools appear as `crm.<tool>` (e.g.
`crm.get_customer`). The `crm` segment comes from the folder name — rename
the folder and the wire names change with it.

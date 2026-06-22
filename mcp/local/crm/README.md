# crm

Demo MCP server backing the **Refund Eligibility** procedure. Thin client over the mock customer service at [mock/customers/](../../../mock/customers/).

Authoring shape: **drop-in**. The folder ships only `tools/*.ts` (and this README). The connector's drop-in scanner ([packages/connector/src/dropin.ts](../../../packages/connector/src/dropin.ts)) discovers it at boot and the synthesized child runtime ([packages/connector/src/sdk/dropin-runner.ts](../../../packages/connector/src/sdk/dropin-runner.ts)) wires the tools — no `server.ts`, no `package.json`, no yaml entry. The folder name (`crm`) becomes the MCP name.

| Tool | Role | Purpose |
|------|------|---------|
| `get_customer`        | identity lookup | Returns name / surname / phone / email keyed by phone. No order history. |
| `get_recent`          | hydration       | Fires server-side before the LLM call. Returns the customer's most recent order keyed by phone (preferred) or email (fallback). |
| `issue_refund`        | side-effect     | Called by the BYO-LLM mid-conversation when it decides the order qualifies. |
| `get_appointment`     | calendar lookup | Returns the customer's next upcoming appointment keyed by phone, or `{ error: "no_appointment" }`. |
| `check_availability`  | calendar query  | Validates a candidate slot. Returns `{ available, reason?, daysFromNow, isSameDay, technician, suggestions[] }`. The procedure reads `daysFromNow` / `isSameDay` to drive the >30d-out and same-day edge cases. |
| `update_appointment`  | side-effect     | Reschedules an appointment to a new start. Returns the updated appointment, or `{ error }` for `slot_taken` / `outside_working_hours` / `in_the_past` / `not_found`. |
| `notify_agent`        | side-effect     | Sends an internal-channel notification to the technician. The customer-facing SMS confirmation is composed separately by the procedure via the bundled twilio MCP's `messages_create`. |

Wire-format tool names through the controller are `customer.crm.get_customer`, `customer.crm.get_recent`, and `customer.crm.issue_refund` — the `crm` segment comes from the folder name. Don't rename the folder without also updating the controller's `EXPECTED_CUSTOMER_TOOLS`.

## Setup

Drop-in: nothing to install, no yaml edit. Start the mock customer service first (terminal 1):

```bash
./scripts/start-mock-server.sh
```

Then the connector (terminal 2):

```bash
npm install && npm run build
cp packages/connector/connector.yaml.example packages/connector/connector.yaml
cp packages/connector/.env.example packages/connector/.env
./scripts/start-connector.sh
```

`MOCK_CUSTOMERS_URL` defaults to `http://localhost:7400`. Override by entering it in the controller UI under Connector → MCPs → crm, or — for offline dev — by copying `mcp/local/crm/.env.example` to `.env` (gitignored). The controller-supplied value wins on conflict.

Inspector UI: <http://localhost:9090/>.

## Demo data

Seeded in [mock/customers/data.ts](../../../mock/customers/data.ts):

| `customer_phone` | Name | Orders |
|---|---|---|
| `+15551239999` | Dana Demo | 3 (delivered, shipped, pending) |
| `+14155550101` | Alice Anderson | `ord_42` — delivered, ~16d, refund-eligible |
| `+14155550102` | Bob Brown | `ord_77` — delivered, ~47d, fails 30-day window |
| `+14155550103` | Carol Chen | `ord_91` — pending, fails status gate |
| (email `purchaser@example.com`) | Pat Purchaser | `ord_gift_5` — gift order edge case |

Anything else returns `{ "error": "no_customer" }` (`get_customer`) or `{ "error": "no_orders" }` (`get_recent`).

## Calendar fixtures

Seeded in [mock/customers/calendar.ts](../../../mock/customers/calendar.ts). Technician **Sam Reyes** holds 1-hour slots Mon-Fri 09:00–17:00 UTC for the next 60 days from service-startup time.

| `phone`           | Pre-booked slot              |
|---|---|
| `+15551239999`    | ~14 working days out, 10:00 UTC (Dana Demo — focal customer for the reschedule demo) |
| `+14155550101`    | ~2 working days out, 14:00 UTC (Alice Anderson) |
| `+14155550102`    | ~7 working days out, 11:00 UTC (Bob Brown) |

Anyone else returns `{ "error": "no_appointment" }` from `get_appointment`. Calendar state is in-memory; restarting the mock service wipes any reschedules.

## Reschedule edge cases (procedure-side)

The connector tools surface raw timing data — the procedure on the controller decides what to do with it:

- **>30 days out** → `check_availability.daysFromNow > 30` → procedure confirms the customer still wants the appointment.
- **Same-day** → `check_availability.isSameDay === true` → procedure escalates to manager approval.
- **Customer >15 min late to confirm** → procedure tracks its own offer timestamp; if elapsed > 15 min before `update_appointment`, re-call `check_availability` first (the slot may have been taken).

## issue_refund failure modes

- `amount` exceeds the order's known total → `{ "error": "amount_exceeds_order_total", ... }`
- Same `orderId` refunded twice in this process's lifetime → `{ "error": "already_refunded", ... }`

The ledger is in-memory only; restarting the connector wipes it.

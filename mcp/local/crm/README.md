# crm-mcp-server

Demo MCP server backing the **Refund Eligibility** procedure. Thin client over the mock customer service at [mock/customers/](../../../mock/customers/).

| Tool | Role | Purpose |
|------|------|---------|
| `get_customer` | identity lookup | Returns name / surname / phone / email keyed by phone. No order history. |
| `get_recent`   | hydration       | Fires server-side before the LLM call. Returns the customer's most recent order keyed by phone (preferred) or email (fallback). |
| `issue_refund` | side-effect     | Called by the BYO-LLM mid-conversation when it decides the order qualifies. |

Wire-format tool names through the controller are `customer.crm.get_customer`, `customer.crm.get_recent`, and `customer.crm.issue_refund` — the `crm` segment comes from this entry's `name:` in `packages/connector/connector.yaml`. Don't rename it without also updating the controller's `EXPECTED_CUSTOMER_TOOLS`.

## Setup

This is a Type 1 example — no per-folder `package.json` deps to install. The
entry already exists in `packages/connector/connector.yaml.example`:

```yaml
- name: crm
  transport: http
  dir: ../../mcp/local/crm
```

Start the mock customer service first (terminal 1):

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

Inspector UI: <http://localhost:9090/>.

## Demo data

Seeded in [mock/customers/data.ts](../../../mock/customers/data.ts):

| `customer phone` | Name | Orders |
|---|---|---|
| `+61401277115` | Des Hartman | 3 (delivered, shipped, pending) |
| `+14155550101` | Alice Anderson | `ord_42` — delivered, ~16d, refund-eligible |
| `+14155550102` | Bob Brown | `ord_77` — delivered, ~47d, fails 30-day window |
| `+14155550103` | Carol Chen | `ord_91` — pending, fails status gate |
| (email `purchaser@example.com`) | Pat Purchaser | `ord_gift_5` — gift order edge case |

Anything else returns `{ "error": "no_customer" }` (`get_customer`) or `{ "error": "no_orders" }` (`get_recent`).

## issue_refund failure modes

- `amount` exceeds the order's known total → `{ "error": "amount_exceeds_order_total", ... }`
- Same `orderId` refunded twice in this process's lifetime → `{ "error": "already_refunded", ... }`

The ledger is in-memory only; restarting the connector wipes it.

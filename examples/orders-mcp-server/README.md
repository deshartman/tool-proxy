# orders-mcp-server

Demo MCP server for the **Refund Eligibility** procedure. Exposes two tools:

| Tool | Role | Purpose |
|------|------|---------|
| `get_recent`   | hydration   | Fires server-side before the LLM call. Returns the customer's most recent order keyed by phone (preferred) or email (fallback). |
| `issue_refund` | side-effect | Called by the BYO-LLM mid-conversation when it decides the order qualifies. |

Wire-format names through the controller are `customer.orders.get_recent` and `customer.orders.issue_refund` — the `orders` segment comes from `mcp_servers[].name` in this directory's `connector.yaml`. Don't rename it without also updating the controller's `EXPECTED_CUSTOMER_TOOLS`.

## Demo fixtures

`get_recent` is keyed by `customer phone`. Three fixtures cover the three branches of the procedure's eligibility gates:

| `customer phone` | `ageDays` | `status`    | Procedure outcome           |
|------------------|-----------|-------------|-----------------------------|
| `+14155550101`   | 16        | `delivered` | proceed to refund           |
| `+14155550102`   | 47        | `delivered` | escalate (age gate fails)   |
| `+14155550103`   | 8         | `pending`   | offer alternatives (status) |
| anything else    | —         | —           | returns `{ "error": "no_orders" }` |

`placedAt` is computed from `ageDays` at call time, so the timestamp and `ageDays` never disagree even if the demo runs months from now.

For the gift-order edge case, `original purchaser email` falls back to one fixture: `purchaser@example.com` → 12 days, delivered.

## issue_refund failure modes

- `amount` exceeds the order's known total → `{ "error": "amount_exceeds_order_total", ... }`
- Same `orderId` refunded twice in this process's lifetime → `{ "error": "already_refunded", ... }`

The ledger is in-memory only; restarting the server wipes it.

## Setup

```bash
npm install
npm run build

cp connector.yaml.example connector.yaml
cp .env.example .env
# fill in CONNECTOR_ID + TUNNEL_AUTH_TOKEN
```

Then run from the repo root:

```bash
./scripts/run-connector.sh
```

Inspector UI for this pairing: <http://localhost:9092/>.

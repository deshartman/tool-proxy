# mock customer service

A throwaway HTTP service that holds customer + interaction fixtures for
local demos. **Not** an MCP, **not** bundled into the connector image,
**not** referenced from `connector.yaml`. Dev-only.

The [orders MCP](../../mcp/local/orders/) reads from this service via
`MOCK_CUSTOMERS_URL` (default `http://localhost:7400`).

## Run

```bash
./scripts/start-mock-server.sh
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/customers?phone=<E.164>` | `{ customer, mostRecent }` or 404 `{ error: "no_customer" }` |
| `GET` | `/customers?email=<addr>` | same shape; fallback for gift orders |
| `GET` | `/orders/:orderId` | interaction + customer name/surname, or 404 |
| `GET` | `/healthz` | `ok` |

## Seeded customers

| Phone | Name | Orders |
|---|---|---|
| +61401277115 | Des Hartman | `ord_des_1` (delivered, 12d), `ord_des_2` (shipped, 3d), `ord_des_3` (pending, 1d) |
| +14155550101 | Alice Anderson | `ord_42` (delivered, 16d) |
| +14155550102 | Bob Brown | `ord_77` (delivered, 47d — fails 30-day refund window) |
| +14155550103 | Carol Chen | `ord_91` (pending, 8d) |
| (email purchaser@example.com) | Pat Purchaser | `ord_gift_5` (delivered, 12d) |

`date` is computed at service-startup time relative to "now", so refund
eligibility against the 30-day window stays meaningful as long as the
service has been running recently.

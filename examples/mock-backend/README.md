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
| `GET` | `/appointments?phone=<E.164>` | next upcoming appointment, or 404 `{ error: "no_appointment" }` |
| `GET` | `/appointments/:apptId` | appointment by id, or 404 |
| `GET` | `/availability?start=<ISO>` | `{ available, reason?, daysFromNow, isSameDay, technician, suggestions[] }` |
| `POST` | `/appointments/:apptId/reschedule` | body `{ newStart }` → updated appointment, or 409 `{ error }` |
| `GET` | `/healthz` | `ok` |

## Seeded customers

The **focal customer** (first row) is env-driven — set `DEMO_CUSTOMER_NAME` /
`DEMO_CUSTOMER_SURNAME` / `DEMO_CUSTOMER_PHONE` in `examples/mock-backend/.env` when
you want live calls or SMS from your own phone to route through the demo.
With those unset, the fallback is `Dana Demo` on a 555 reserved-range number
that can't collide with a real subscriber. Copy `.env.example` to `.env` to
get started.

| Phone | Name | Orders |
|---|---|---|
| `$DEMO_CUSTOMER_PHONE` (default +15551239999) | `$DEMO_CUSTOMER_NAME $DEMO_CUSTOMER_SURNAME` (default Dana Demo) | 7 interactions: `ord_focal_1` (delivered, 12d), `ord_focal_2` (shipped, 3d), `ord_focal_3` (pending, 1d), `ord_focal_4` (delivered, 35d — >30d refund window), `ord_focal_5..7` (older delivered history) |
| +14155550101 | Alice Anderson | `ord_42` (delivered, 16d) |
| +14155550102 | Bob Brown | `ord_77` (delivered, 47d — fails 30-day refund window) |
| +14155550103 | Carol Chen | `ord_91` (pending, 8d) |
| (email purchaser@example.com) | Pat Purchaser | `ord_gift_5` (delivered, 12d) |

Alice/Bob/Carol/Pat stay hardcoded — their order age + status combinations
are behavior fixtures for the refund-eligibility procedure (eligible / >30d /
not-delivered / email-only), not seed data an operator would want to swap
out.

`date` is computed at service-startup time relative to "now", so refund
eligibility against the 30-day window stays meaningful as long as the
service has been running recently.

# mock customer service

Postgres-backed customer store fronting the [CRM drop-in](../demos/crm/).
Serves the identity / order / appointment queries the CRM tools consume,
plus an operator write surface (`POST /customers`, `POST /appointments`)
so an operator can populate customer entries via the connector inspector's
CRM Insert panel.

**Not** an MCP, **not** loaded by the connector as a drop-in, **not**
in `connector.yaml`. Runs as its own private-only Fly app
(`twilio-tool-sdk-mock` in production, sibling to `-db`)
and is reached by the CRM drop-in at `${MOCK_CUSTOMERS_URL}` (typically
`http://twilio-tool-sdk-mock.internal:7400`).

## What changed from the demo shape

Historically this was an in-memory fixture service with `DEMO_CUSTOMER_*`
env-driven focal customer + hardcoded Alice / Bob / Carol / Pat. Retired
in favour of a real Postgres store per the `MOCK-BACKEND-DB` plan:

- No more fixtures. First-boot database is empty. Operator inserts via
  `POST /customers` on this service. (There is no inspector CRM panel —
  the connector's inspector does not reach into this store.)
- `DEMO_CUSTOMER_*` env vars retired. The `MOCK_POSTGRES_URL` secret is
  the only env the service reads at boot (plus optional `PORT` /
  `LOG_LEVEL`).
- All customer + interaction + appointment state persists across mock
  restarts — the `crm` database on `twilio-tool-sdk-db` is the source
  of truth.

Business logic (working-hours model, `checkAvailability`,
`findNearbySlots`, reschedule state machine) still lives in `calendar.ts` —
only the storage layer changed.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/customers?phone=<E.164>` | `{ customer, mostRecent }` or 404 `{ error: "no_customer" }` |
| `GET`  | `/customers?email=<addr>` | same shape; fallback for gift-order email lookups |
| `POST` | `/customers` | Create a customer + optional inline interactions. See below. |
| `GET`  | `/orders/:orderId` | interaction + customer name/surname, or 404 |
| `GET`  | `/appointments?phone=<E.164>` | next upcoming appointment for the customer, or 404 |
| `GET`  | `/appointments/:apptId` | appointment by id, or 404 |
| `POST` | `/appointments` | Create an appointment for an existing customer. Body: `{ customerPhone, start }`. |
| `POST` | `/appointments/:apptId/reschedule` | body `{ newStart }` → updated appointment, or 409 `{ error }` |
| `GET`  | `/availability?start=<ISO>` | `{ available, reason?, daysFromNow, isSameDay, technician, suggestions[] }` |
| `GET`  | `/healthz` | `ok` |

## `POST /customers` body

```json
{
  "name": "Alex",
  "surname": "Operator",
  "phone": "+61XXXXXXXXX",
  "email": "alex@example.com",
  "interactions": [
    {
      "orderId": "ord_alex_1",
      "placedAt": "2026-07-15T10:00:00Z",
      "status": "delivered",
      "channel": "web",
      "amount": 89.50,
      "currency": "USD",
      "reason": "online purchase",
      "resolution": "delivered to address"
    }
  ]
}
```

- Either `phone` or `email` is required (both is fine — each is uniquely
  indexed).
- `interactions[]` is optional. Absent or empty = a customer with no
  orders; `get_customer` still hydrates, `get_recent` returns an empty list.
- Responses:
  - `201 { customer, mostRecent }` on success
  - `409 { error: "duplicate_phone" | "duplicate_email" }` on conflict
  - `400 { error: "validation_error", detail }` on bad input

## `POST /appointments` body

```json
{
  "customerPhone": "+61XXXXXXXXX",
  "start": "2026-08-01T14:00:00Z"
}
```

- `start` must be on the hour, Mon-Fri 09:00-16:00 UTC.
- The customer must already exist (create via `POST /customers` first).
- Responses:
  - `201 Appointment` on success
  - `404 { error: "no_customer" }` if the phone doesn't match a customer
  - `409 { error: "slot_taken" | "outside_working_hours" | "in_the_past" }`

## Schema

Three tables in the `crm` database. See
[`migrations/001_crm_schema.sql`](migrations/001_crm_schema.sql) for the
authoritative shape.

```
customers      (id, name, surname, phone UNIQUE, email UNIQUE, created_at)
interactions   (order_id PK, customer_id FK, placed_at, status, channel,
                amount, currency, reason, resolution)
appointments   (id, customer_id FK, slot_start UNIQUE, slot_end, status,
                rescheduled_at, rescheduled_from, created_at)
```

Migrations run on boot, tracked in `schema_migrations`. Adding a new
migration file with a higher numeric prefix (e.g. `002_...`) causes it to
run once on next boot.

## Local dev

Zero-config from a fresh clone:

```bash
./scripts/start-mock-server.sh
```

The script auto-starts the dev Postgres container
(`mcp-shim-ek-postgres` via `deploy/compose/docker-compose.dev.yml`),
idempotently creates the `crm` database, defaults `MOCK_POSTGRES_URL`
to the container's DSN, and boots the service on port `7400`. Sources
`examples/mock-backend/.env` if present (wins over auto-provisioning).
Migrations run on first boot.

Manual override — point at a different Postgres (e.g. fly-proxy the
production one via `fly proxy 5432:5432 -a twilio-tool-sdk-db`):

```bash
export MOCK_POSTGRES_URL="postgres://postgres:<pw>@localhost:5432/crm"
./scripts/start-mock-server.sh
```

The `crm` database must already exist on that Postgres (`psql -c
"CREATE DATABASE crm"`); the script's idempotent `CREATE DATABASE`
only fires against the auto-provisioned dev container.

## Production (Fly.io)

Deployed as `twilio-tool-sdk-mock`. The manifests are **generated, not checked in** —
run `mcp-connector deploy init --target fly-mock`, which emits them in-tree alongside
the mock source it packages. See [`../../deploy/fly/README.md`](../../deploy/fly/README.md)
for the Fly operator runbook.

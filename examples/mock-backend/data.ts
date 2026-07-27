// Customer + interaction (order) data layer. Postgres-backed as of the
// MOCK-BACKEND-DB plan — retired the in-memory CUSTOMERS[] array along
// with the DEMO_CUSTOMER_* env vars and the Alice/Bob/Carol/Pat behavior
// fixtures. First-boot database is empty; the operator inserts rows via
// the inspector's CRM Insert panel (which proxies POST /customers on
// this service).
//
// Callers (server.ts, calendar.ts) only see the exported functions —
// SQL stays in this module.

import { query } from "./db.js";

export interface Interaction {
  orderId: string;
  date: string;        // ISO 8601 — placed_at as string for JSON output
  reason: string;
  resolution: string;
  status: "delivered" | "pending" | "shipped" | "cancelled";
  channel: "web" | "store" | "phone";
  amount: number;
  currency: string;
}

export interface Customer {
  id: string;              // uuid, internal — not exposed on the CRM tools' wire
  name: string;
  surname: string;
  phone?: string;
  email?: string;
  interactions: Interaction[];
}

interface CustomerRow {
  id: string;
  name: string;
  surname: string;
  phone: string | null;
  email: string | null;
}

interface InteractionRow {
  order_id: string;
  customer_id: string;
  placed_at: Date;
  status: string;
  channel: string;
  amount: string;         // pg returns numeric as string to avoid precision loss
  currency: string;
  reason: string | null;
  resolution: string | null;
}

function rowToInteraction(r: InteractionRow): Interaction {
  return {
    orderId: r.order_id,
    date: r.placed_at.toISOString(),
    status: r.status as Interaction["status"],
    channel: r.channel as Interaction["channel"],
    amount: Number(r.amount),
    currency: r.currency,
    reason: r.reason ?? "",
    resolution: r.resolution ?? "",
  };
}

async function loadInteractions(customerId: string): Promise<Interaction[]> {
  const { rows } = await query<InteractionRow>(
    `SELECT order_id, customer_id, placed_at, status, channel, amount, currency, reason, resolution
       FROM interactions WHERE customer_id = $1 ORDER BY placed_at DESC`,
    [customerId],
  );
  return rows.map(rowToInteraction);
}

function normalizePhone(raw: string): string {
  return raw.replace(/[\s()-]/g, "");
}

export async function lookupByPhone(phone: string): Promise<Customer | undefined> {
  const target = normalizePhone(phone);
  const { rows } = await query<CustomerRow>(
    "SELECT id, name, surname, phone, email FROM customers WHERE phone = $1 LIMIT 1",
    [target],
  );
  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    surname: r.surname,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    interactions: await loadInteractions(r.id),
  };
}

export async function lookupByEmail(email: string): Promise<Customer | undefined> {
  const { rows } = await query<CustomerRow>(
    "SELECT id, name, surname, phone, email FROM customers WHERE email = $1 LIMIT 1",
    [email.trim()],
  );
  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    surname: r.surname,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    interactions: await loadInteractions(r.id),
  };
}

export async function lookupOrder(
  orderId: string,
): Promise<{ customer: Customer; interaction: Interaction } | undefined> {
  const { rows } = await query<InteractionRow & CustomerRow>(
    `SELECT i.order_id, i.customer_id, i.placed_at, i.status, i.channel,
            i.amount, i.currency, i.reason, i.resolution,
            c.id, c.name, c.surname, c.phone, c.email
       FROM interactions i JOIN customers c ON c.id = i.customer_id
       WHERE i.order_id = $1 LIMIT 1`,
    [orderId],
  );
  if (rows.length === 0) return undefined;
  const r = rows[0];
  const interaction = rowToInteraction({
    order_id: r.order_id,
    customer_id: r.customer_id,
    placed_at: r.placed_at,
    status: r.status,
    channel: r.channel,
    amount: r.amount,
    currency: r.currency,
    reason: r.reason,
    resolution: r.resolution,
  });
  const customer: Customer = {
    id: r.id,
    name: r.name,
    surname: r.surname,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    interactions: await loadInteractions(r.id),
  };
  return { customer, interaction };
}

export function mostRecent(customer: Customer): Interaction | undefined {
  // Interactions come back from Postgres already sorted newest-first by
  // loadInteractions's ORDER BY, so this is just [0].
  return customer.interactions[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Write path — used by server.ts's POST /customers.
// ─────────────────────────────────────────────────────────────────────────

export interface CreateCustomerInput {
  name: string;
  surname: string;
  phone?: string;
  email?: string;
  interactions?: Array<{
    orderId: string;
    placedAt: string;       // ISO 8601
    status: string;
    channel: string;
    amount: number;
    currency?: string;
    reason?: string;
    resolution?: string;
  }>;
}

export type CreateCustomerResult =
  | { ok: true; customer: Customer }
  | { ok: false; error: "duplicate_phone" | "duplicate_email" | "validation_error"; detail?: string };

export async function createCustomer(
  input: CreateCustomerInput,
): Promise<CreateCustomerResult> {
  if (!input.name?.trim() || !input.surname?.trim()) {
    return { ok: false, error: "validation_error", detail: "name and surname are required" };
  }
  if (!input.phone && !input.email) {
    return { ok: false, error: "validation_error", detail: "at least one of phone or email is required" };
  }

  const phone = input.phone ? normalizePhone(input.phone) : null;
  const email = input.email?.trim() ?? null;

  // Pre-check for duplicates so we can return a friendly error envelope
  // rather than a raw unique-violation. Race between check and insert is
  // caught by the unique index — code 23505 falls through to the same error.
  if (phone) {
    const dup = await query("SELECT 1 FROM customers WHERE phone = $1", [phone]);
    if (dup.rowCount) return { ok: false, error: "duplicate_phone" };
  }
  if (email) {
    const dup = await query("SELECT 1 FROM customers WHERE email = $1", [email]);
    if (dup.rowCount) return { ok: false, error: "duplicate_email" };
  }

  const client = await (await import("./db.js")).pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO customers (name, surname, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.name.trim(), input.surname.trim(), phone, email],
    );
    const customerId = rows[0].id;

    for (const i of input.interactions ?? []) {
      await client.query(
        `INSERT INTO interactions
           (order_id, customer_id, placed_at, status, channel, amount, currency, reason, resolution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          i.orderId,
          customerId,
          new Date(i.placedAt),
          i.status,
          i.channel,
          i.amount,
          i.currency ?? "USD",
          i.reason ?? null,
          i.resolution ?? null,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      // Fallback in case the pre-check races. Distinguish which by
      // constraint name when we can, otherwise a generic duplicate.
      const detail = (err as { detail?: string }).detail ?? "";
      if (detail.toLowerCase().includes("phone")) return { ok: false, error: "duplicate_phone" };
      if (detail.toLowerCase().includes("email")) return { ok: false, error: "duplicate_email" };
      return { ok: false, error: "duplicate_phone" };
    }
    throw err;
  } finally {
    client.release();
  }

  // Round-trip via lookup for a consistent shape (fresh joins,
  // interactions ordered newest-first, etc.).
  const created = phone
    ? await lookupByPhone(phone)
    : await lookupByEmail(email!);
  if (!created) throw new Error("customer disappeared right after insert — should not happen");
  return { ok: true, customer: created };
}

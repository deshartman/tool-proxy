// Postgres-backed customer service, fronting the crm database on the
// shared Fly Postgres. Runs boot-time migrations before opening the
// listener. Sibling apps in the same Fly org reach this at
// <app>.internal:7400 — no public IP, no [[services]].
//
// Endpoints:
//   GET  /customers?phone=<E164>          → { customer, mostRecent } | 404
//   GET  /customers?email=<addr>          → { customer, mostRecent } | 404
//   POST /customers                       → 201 { customer, mostRecent } | 400 | 409
//   GET  /orders/:orderId                 → { …interaction, customerName, customerSurname } | 404
//   GET  /appointments?phone=<E164>       → Appointment | 404
//   GET  /appointments/:id                → Appointment | 404
//   POST /appointments                    → 201 Appointment | 400 | 409
//   POST /appointments/:id/reschedule     → 200 Appointment | 409 { error }
//   GET  /availability?start=<ISO>        → AvailabilityResult
//   GET  /healthz                         → 200 ok

import http from "node:http";
import { URL } from "node:url";
import { pino } from "pino";
import {
  lookupByPhone,
  lookupByEmail,
  lookupOrder,
  mostRecent,
  createCustomer,
  type CreateCustomerInput,
} from "./data.js";
import {
  findAppointmentByPhone,
  findAppointmentById,
  checkAvailability,
  rescheduleAppointment,
  createAppointment,
} from "./calendar.js";
import { runMigrations, closePool } from "./db.js";

const PORT = Number(process.env.PORT ?? 7400);

const pretty = process.env.NODE_ENV !== "production" && Boolean(process.stdout.isTTY);
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname", messageFormat: "{component} | {msg}" },
        },
      }
    : {}),
}).child({ component: "mock-customers" });

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain" : "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const RESCHEDULE_PATH = /^\/appointments\/([^/]+)\/reschedule$/;
const ORDER_PATH = /^\/orders\/([^/]+)$/;

const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    log.error({ err }, "handler error");
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!req.url) {
    send(res, 400, { error: "bad_request" });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "POST") {
    const rm = RESCHEDULE_PATH.exec(path);
    if (rm) {
      const body = (await readJsonBody(req)) as { newStart?: string };
      if (!body?.newStart) {
        send(res, 400, { error: "missing_newStart" });
        return;
      }
      const result = await rescheduleAppointment(decodeURIComponent(rm[1]), body.newStart);
      if (!result.ok) {
        send(res, 409, { error: result.error });
        return;
      }
      send(res, 200, result.appointment);
      return;
    }

    if (path === "/customers") {
      const body = (await readJsonBody(req)) as CreateCustomerInput;
      const result = await createCustomer(body);
      if (!result.ok) {
        const status = result.error === "validation_error" ? 400 : 409;
        send(res, status, { error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
        return;
      }
      send(res, 201, { customer: result.customer, mostRecent: mostRecent(result.customer) ?? null });
      return;
    }

    if (path === "/appointments") {
      const body = (await readJsonBody(req)) as { customerPhone?: string; start?: string };
      if (!body?.customerPhone || !body?.start) {
        send(res, 400, { error: "missing_fields", detail: "customerPhone and start are required" });
        return;
      }
      const result = await createAppointment(body.customerPhone, body.start);
      if (!result.ok) {
        const status = result.error === "no_customer" ? 404 : 409;
        send(res, status, { error: result.error });
        return;
      }
      send(res, 201, result.appointment);
      return;
    }

    send(res, 404, { error: "not_found", path, method });
    return;
  }

  if (method !== "GET") {
    send(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (path === "/healthz") {
    send(res, 200, "ok");
    return;
  }

  if (path === "/customers") {
    const phone = url.searchParams.get("phone");
    const email = url.searchParams.get("email");
    const customer =
      (phone ? await lookupByPhone(phone) : undefined) ??
      (email ? await lookupByEmail(email) : undefined);
    if (!customer) {
      send(res, 404, { error: "no_customer" });
      return;
    }
    send(res, 200, { customer, mostRecent: mostRecent(customer) ?? null });
    return;
  }

  if (path === "/appointments") {
    const phone = url.searchParams.get("phone");
    if (!phone) {
      send(res, 400, { error: "missing_phone" });
      return;
    }
    const appt = await findAppointmentByPhone(phone);
    if (!appt) {
      send(res, 404, { error: "no_appointment" });
      return;
    }
    send(res, 200, appt);
    return;
  }

  const apptIdMatch = /^\/appointments\/([^/]+)$/.exec(path);
  if (apptIdMatch) {
    const appt = await findAppointmentById(decodeURIComponent(apptIdMatch[1]));
    if (!appt) {
      send(res, 404, { error: "no_appointment" });
      return;
    }
    send(res, 200, appt);
    return;
  }

  if (path === "/availability") {
    const start = url.searchParams.get("start");
    if (!start) {
      send(res, 400, { error: "missing_start" });
      return;
    }
    send(res, 200, await checkAvailability(start));
    return;
  }

  const orderMatch = ORDER_PATH.exec(path);
  if (orderMatch) {
    const hit = await lookupOrder(decodeURIComponent(orderMatch[1]));
    if (!hit) {
      send(res, 404, { error: "no_order" });
      return;
    }
    send(res, 200, {
      ...hit.interaction,
      customerName: hit.customer.name,
      customerSurname: hit.customer.surname,
    });
    return;
  }

  send(res, 404, { error: "not_found", path });
}

async function main(): Promise<void> {
  log.info("running migrations");
  await runMigrations();
  log.info("migrations complete");

  server.listen(PORT, () => {
    log.info({ port: PORT, url: `http://localhost:${PORT}` }, "listening");
  });
}

const shutdown = async (sig: string): Promise<void> => {
  log.info({ signal: sig }, "received signal — closing");
  server.close();
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

void main().catch((err) => {
  log.error({ err }, "fatal boot error");
  process.exit(1);
});

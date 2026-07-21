// Tiny mock customer service. Read-only HTTP, no auth, in-memory data.
// Started as a separate process in dev (./scripts/start-mock-server.sh);
// the orders MCP fetches from it via MOCK_CUSTOMERS_URL.
//
// Endpoints:
//   GET /customers?phone=<E164>      -> { customer, mostRecent } | 404
//   GET /customers?email=<addr>      -> { customer, mostRecent } | 404
//   GET /orders/:orderId             -> { interaction, name, surname } | 404
//   GET /healthz                     -> 200 ok

import http from "node:http";
import { URL } from "node:url";
import { pino } from "pino";
import { lookupByPhone, lookupByEmail, lookupOrder, mostRecent } from "./data.js";
import {
  findAppointmentByPhone,
  findAppointmentById,
  checkAvailability,
  rescheduleAppointment,
} from "./calendar.js";

const PORT = Number(process.env.PORT ?? 7400);

// Mirror the connector's logger shape: pretty in TTY, JSON in non-TTY.
// This package doesn't depend on @mcp-shim/connector/sdk, so the setup is
// inlined rather than imported.
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
  void handle(req, res).catch(err => {
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
    const m = RESCHEDULE_PATH.exec(path);
    if (m) {
      const body = await readJsonBody(req) as { newStart?: string };
      if (!body?.newStart) {
        send(res, 400, { error: "missing_newStart" });
        return;
      }
      const result = rescheduleAppointment(decodeURIComponent(m[1]), body.newStart);
      if (!result.ok) {
        send(res, 409, { error: result.error });
        return;
      }
      send(res, 200, result.appointment);
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
      (phone ? lookupByPhone(phone) : undefined) ??
      (email ? lookupByEmail(email) : undefined);
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
    const appt = findAppointmentByPhone(phone);
    if (!appt) {
      send(res, 404, { error: "no_appointment" });
      return;
    }
    send(res, 200, appt);
    return;
  }

  const apptIdMatch = /^\/appointments\/([^/]+)$/.exec(path);
  if (apptIdMatch) {
    const appt = findAppointmentById(decodeURIComponent(apptIdMatch[1]));
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
    send(res, 200, checkAvailability(start));
    return;
  }

  const orderMatch = ORDER_PATH.exec(path);
  if (orderMatch) {
    const hit = lookupOrder(decodeURIComponent(orderMatch[1]));
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

server.listen(PORT, () => {
  log.info({ port: PORT, url: `http://localhost:${PORT}` }, `listening`);
});

const shutdown = (sig: string) => {
  log.info({ signal: sig }, `received signal — closing`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

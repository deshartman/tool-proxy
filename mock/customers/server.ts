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
import { lookupByPhone, lookupByEmail, lookupOrder, mostRecent } from "./data.js";

const PORT = Number(process.env.PORT ?? 7400);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain" : "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (!req.url || req.method !== "GET") {
    send(res, 405, { error: "method_not_allowed" });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

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

  const orderMatch = path.match(/^\/orders\/([^/]+)$/);
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
});

server.listen(PORT, () => {
  console.log(`[mock-customers] listening on http://localhost:${PORT}`);
});

const shutdown = (sig: string) => {
  console.log(`[mock-customers] received ${sig}, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

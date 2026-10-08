import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { startHealthServer, livez, readyz, type HealthState } from "../../src/health/server.js";

// Stage A of architectural-plans/DEPLOY-ARCHITECTURE.md. These endpoints exist
// because the inspector cannot be probed: it binds 127.0.0.1 and refuses every
// non-loopback caller, so a kubelet / ECS agent / ALB cannot reach it. Measured
// during the live AWS deploy — from the container's host, `curl 127.0.0.1:9090`
// is refused, and widening the bind answers 403 because the gate judges the
// caller's address.
//
// The distinction the two routes encode is the whole point, and it is easy to
// collapse by accident: LIVENESS answers "restart this process?", READINESS
// answers "send it work?". Folding the tunnel check into liveness would turn one
// controller outage into a fleet-wide restart storm.

const ready: HealthState = { configLoaded: true, tunnelOpen: true, childrenPending: [] };

describe("livez — liveness must not depend on the tunnel", () => {
  it("returns 200 regardless of state", () => {
    expect(livez()).toEqual({ status: 200, body: { ok: true } });
  });

  it("is a pure function of nothing — it cannot observe the tunnel", () => {
    // Stated as a test because the tempting "improvement" is to pass state in
    // and check the tunnel. If liveness ever failed on a controller outage,
    // every orchestrator in the fleet would kill its connector at the same
    // moment the reconnect backoff is trying to spread the herd out.
    expect(livez.length).toBe(0);
  });
});

describe("readyz — the gate, and the order it reports failures in", () => {
  it("200 when config is loaded, no child pending, tunnel open", () => {
    expect(readyz(ready)).toEqual({ status: 200, body: { ok: true } });
  });

  it("503 config_not_loaded before boot finishes parsing", () => {
    const r = readyz({ ...ready, configLoaded: false });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("config_not_loaded");
  });

  it("503 tunnel_not_open on a fresh, unconfigured deploy", () => {
    // Deliberate, and the most consequential decision in this file: a connector
    // that has never been through Configure Tunnel has no identity and can
    // serve no tool call, so it is NOT ready. Operators must not wire this to a
    // restart policy, or the process dies before they can reach the modal —
    // which is exactly why liveness is separate and unconditional.
    const r = readyz({ ...ready, tunnelOpen: false });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("tunnel_not_open");
  });

  it("503 mcp_children_starting, naming which children", () => {
    const r = readyz({ ...ready, childrenPending: ["crm", "salesforce"] });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("mcp_children_starting");
    expect(r.body.detail).toEqual({ pending: ["crm", "salesforce"] });
  });

  it("reports children BEFORE the tunnel when both are unmet", () => {
    // Ordering is the operator-facing part. Children come up before the tunnel
    // dials, so during a normal boot "still starting" is the true cause and
    // "tunnel not open" is a downstream symptom. Reporting the symptom would
    // send someone debugging their controller.
    const r = readyz({ configLoaded: true, tunnelOpen: false, childrenPending: ["crm"] });
    expect(r.body.reason).toBe("mcp_children_starting");
  });

  it("does not gate on a permanently-failed child", () => {
    // Q-A1, decided. The connector's continue-on-fail property means one broken
    // drop-in must not take the deployment down — and a permanently-failed MCP
    // never recovers by itself, so gating on it would hold the pod unready
    // forever and hand the orchestrator a restart loop that fixes nothing.
    //
    // The caller enforces this by what it puts in childrenPending (lifecycle.ts
    // filters to restarting/stopped). This test pins the CONTRACT: a ready
    // tunnel with an empty pending list is ready, however many children failed.
    expect(readyz(ready).status).toBe(200);
  });
});

describe("health server — over real HTTP", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  async function serve(state: () => HealthState): Promise<string> {
    // `ephemeral` rather than relying on port 0: 0 means DISABLED here, the
    // same as INSPECTOR_PORT=0. Overloading it would make a test helper and
    // an operator kill-switch indistinguishable.
    const server = startHealthServer({ port: 0, ephemeral: true, getState: state });
    if (!server) throw new Error("server not started");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("serves /livez 200 and /readyz 503 on an unconfigured connector", async () => {
    const base = await serve(() => ({ configLoaded: true, tunnelOpen: false, childrenPending: [] }));

    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect((await ready.json()).reason).toBe("tunnel_not_open");
  });

  it("flips /readyz to 200 when the tunnel opens, without a restart", async () => {
    // The state provider is read per request, not captured once. A cached
    // boolean would go stale on every reconnect and leave a healthy connector
    // permanently unready.
    let open = false;
    const base = await serve(() => ({ configLoaded: true, tunnelOpen: open, childrenPending: [] }));

    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    open = true;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    open = false;
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  });

  it("404s any other path — there is no third route", async () => {
    // The reason this is a separate server rather than two inspector routes:
    // there is nothing else here for a routing mistake to expose.
    const base = await serve(() => ready);
    for (const path of ["/", "/state", "/mcp/messages", "/internal/webhook/stream", "/livez/../state"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, `${path} must not be served`).toBe(404);
    }
  });

  it("rejects non-GET with 405", async () => {
    const base = await serve(() => ready);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/readyz`, { method });
      expect(res.status, method).toBe(405);
    }
  });

  it("answers HEAD with no body, for probes that use it", async () => {
    const base = await serve(() => ready);
    const res = await fetch(`${base}/livez`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("survives a throwing state provider instead of crash-looping", async () => {
    // A bug in status collection must not take the health server down with it —
    // that converts an observability bug into a restart loop.
    const base = await serve(() => { throw new Error("supervisor exploded"); });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("state_unavailable");
    // And liveness is unaffected: the process is still alive.
    expect((await fetch(`${base}/livez`)).status).toBe(200);
  });

  it("sends no-store, since probes poll every few seconds", async () => {
    const base = await serve(() => ready);
    const res = await fetch(`${base}/readyz`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns undefined when the port is 0 (disabled)", () => {
    // HEALTH_PORT=0 is an operator kill-switch, matching INSPECTOR_PORT=0.
    expect(startHealthServer({ port: 0, getState: () => ready })).toBeUndefined();
  });
});

// Several connectors on one host (D6): a second instance that silently lost
// its HEALTH_PORT bind leaves its probe reading the FIRST instance's /readyz.
// An explicitly chosen port therefore fails loudly; the default stays
// non-fatal (losing probes degrades observability, not function).
describe("health server — bind clash", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  async function holdPort(): Promise<number> {
    const first = startHealthServer({ port: 0, ephemeral: true, getState: () => ready })!;
    servers.push(first);
    await new Promise((r) => first.once("listening", r));
    return (first.address() as AddressInfo).port;
  }

  it("calls onFatal on EADDRINUSE when failOnBindError is set", async () => {
    const port = await holdPort();
    const fatal = await new Promise<Error>((resolve) => {
      const second = startHealthServer({ port, getState: () => ready, failOnBindError: true, onFatal: resolve });
      if (second) servers.push(second);
    });
    expect((fatal as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
  });

  it("does not call onFatal on EADDRINUSE for the default (failOnBindError unset)", async () => {
    const port = await holdPort();
    let fatal = false;
    const second = startHealthServer({ port, getState: () => ready, onFatal: () => { fatal = true; } })!;
    servers.push(second);
    await new Promise((r) => second.once("error", r));
    expect(fatal).toBe(false);
  });
});

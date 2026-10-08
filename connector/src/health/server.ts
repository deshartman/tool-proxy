// Orchestrator health endpoints: /livez and /readyz on their own tiny server.
//
// WHY A SECOND SERVER RATHER THAN TWO MORE INSPECTOR ROUTES
//
// The inspector binds 127.0.0.1 and refuses every non-loopback caller, which is
// load-bearing (the Webhooks panel exposes bcrypt-protected URLs). A kubelet, an
// ECS agent or an ALB probes from outside that namespace, so it cannot reach the
// inspector at all — measured during the AWS deploy: from the container's host,
// `curl 127.0.0.1:9090` is refused, and a widened bind answers
// `403 forbidden: loopback only` because the gate judges the caller's address.
//
// Splitting the inspector's bind by route was considered and rejected: one edit
// to that routing table would leak the rest of the dashboard. A separate server
// with exactly two routes and nothing else has no such failure mode — there is
// no third route for a mistake to expose.
//
// THE PROBE THIS REPLACES
//
// Every emitted manifest currently runs `wget -qO- http://127.0.0.1:9090/`
// inside the container as an `exec` probe. That works, but it is per-platform
// (Fargate's healthCheck, a K8s exec probe, ACA's own shape), it needs a shell
// and wget in the image, and it reports only "the HTTP server answers" — it
// cannot distinguish a connector whose tunnel is down.

import { createServer, type Server } from "node:http";
import type { Logger } from "pino";

/** What readiness is allowed to ask about. Deliberately small. */
export interface HealthState {
  /** False until config is loaded and boot has got past its early returns. */
  configLoaded: boolean;
  /**
   * True only on an `ok` register-ack. A dialling or reconnecting tunnel is NOT
   * ready — that is the entire point of the check.
   */
  tunnelOpen: boolean;
  /**
   * Children that are neither running nor permanently-failed, i.e. still
   * starting or restarting. Ready waits for these.
   *
   * Q-A1, decided: `permanently-failed` children are EXCLUDED from the gate.
   * The connector's continue-on-fail property means one broken drop-in must not
   * take the deployment down — and a permanently-failed MCP never recovers on
   * its own, so gating on it would hold the pod unready forever and hand the
   * orchestrator a restart loop that cannot fix anything. The failure is already
   * visible in the inspector's MCP Status panel and in the logs.
   */
  childrenPending: string[];
}

export interface HealthResult {
  status: number;
  body: { ok: boolean; reason?: string; detail?: Record<string, unknown> };
}

/**
 * Liveness: is the process up and serving? No WS check, deliberately.
 *
 * If this gated on the tunnel, a controller outage would make every
 * orchestrator in the fleet kill its connector — turning someone else's
 * downtime into a self-inflicted restart storm, right when the backoff jitter
 * in tunnel/reconnect.ts is trying to spread the herd out. Liveness answers
 * "should I restart this process", and the answer during a controller outage is
 * no.
 */
export function livez(): HealthResult {
  return { status: 200, body: { ok: true } };
}

/**
 * Readiness: is this connector doing its job? 200 when config is loaded, no
 * child is still coming up, and the tunnel is open. 503 otherwise, naming the
 * first unmet condition so an operator reading `kubectl describe` learns
 * something.
 *
 * Note what readiness does NOT gate on, and never should: the config store.
 * It matters at boot and at Configure-Tunnel time, not per-request — and a
 * store hiccup that failed readiness would restart a connector whose tunnel is
 * perfectly healthy.
 *
 * **An unconfigured connector is deliberately NOT ready.** A fresh deploy sits
 * at 503 `tunnel_not_open` until an operator completes Configure Tunnel, which
 * is correct: it has no identity and can serve no tool call. Operators must not
 * wire this to a restart policy that would kill the process before they can
 * reach the modal — which is why liveness exists and is separate.
 */
export function readyz(state: HealthState): HealthResult {
  if (!state.configLoaded) {
    return { status: 503, body: { ok: false, reason: "config_not_loaded" } };
  }
  if (state.childrenPending.length > 0) {
    return {
      status: 503,
      body: {
        ok: false,
        reason: "mcp_children_starting",
        detail: { pending: state.childrenPending },
      },
    };
  }
  if (!state.tunnelOpen) {
    return { status: 503, body: { ok: false, reason: "tunnel_not_open" } };
  }
  return { status: 200, body: { ok: true } };
}

export interface HealthServerOptions {
  port: number;
  /** Read fresh per request — the state changes under us constantly. */
  getState: () => HealthState;
  log?: Logger;
  /**
   * Bind address. Defaults to `0.0.0.0` because the whole point is to be
   * reachable by an orchestrator outside this network namespace. That is safe
   * here and nowhere else in this codebase: the only two routes are these, they
   * are GET-only, and they disclose nothing but a boolean and a reason string.
   */
  bindAddr?: string;
  /**
   * Listen on an OS-assigned ephemeral port instead of treating `port: 0` as
   * "disabled". Tests need this; nothing in production does, which is why it is
   * an explicit opt-in rather than a reinterpretation of 0.
   *
   * The collision is real and worth naming: `HEALTH_PORT=0` disables the
   * endpoints (matching `INSPECTOR_PORT=0`), but 0 is also how you ask the OS
   * for any free port. Overloading one value for both would make a test helper
   * and an operator's kill-switch indistinguishable.
   */
  ephemeral?: boolean;
  /**
   * Treat `EADDRINUSE` as fatal (calls `onFatal`). Set when the operator
   * chose HEALTH_PORT explicitly; the default port stays non-fatal.
   */
  failOnBindError?: boolean;
  onFatal?: (error: Error) => void;
}

/**
 * Start the health server. Returns undefined when `port` is 0, which disables
 * it — matching how INSPECTOR_PORT=0 disables the inspector.
 */
export function startHealthServer(opts: HealthServerOptions): Server | undefined {
  if (opts.port === 0 && !opts.ephemeral) {
    opts.log?.info("health endpoints disabled (HEALTH_PORT=0)");
    return undefined;
  }

  const bindAddr = opts.bindAddr ?? "0.0.0.0";

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    // GET/HEAD only. A probe never needs anything else, and refusing the rest
    // keeps this surface as small as it reads.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
      return;
    }

    let result: HealthResult;
    if (path === "/livez") {
      result = livez();
    } else if (path === "/readyz") {
      // A throwing state provider must not take the health server with it —
      // that would turn a status bug into a restart loop.
      try {
        result = readyz(opts.getState());
      } catch (error) {
        opts.log?.error({ err: error }, "readyz state provider threw");
        result = { status: 503, body: { ok: false, reason: "state_unavailable" } };
      }
    } else {
      result = { status: 404, body: { ok: false, reason: "not_found" } };
    }

    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      // Probes are polled every few seconds; nothing here may be cached.
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : payload);
  });

  server.on("error", (error) => {
    // A port clash on the DEFAULT port must not be fatal. The connector's job
    // is the tunnel; losing the probes degrades observability, not function.
    //
    // An EXPLICIT port is different. With several connectors on one host
    // (D6), a second instance that silently lost its bind leaves its probe
    // reading the first instance's /readyz — the orchestrator then judges
    // this process by another's health. An operator who set HEALTH_PORT
    // asked for that port specifically, so failing loudly is the honest answer.
    opts.log?.error({ err: error, port: opts.port }, "health server error");
    if (opts.failOnBindError && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      opts.onFatal?.(error);
    }
  });

  server.listen(opts.port, bindAddr, () => {
    opts.log?.info(
      { port: opts.port, bindAddr, routes: ["/livez", "/readyz"] },
      "health endpoints listening",
    );
  });

  return server;
}

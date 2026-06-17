// Inbound frame dispatch for the tunnel. A pure(ish) factory so the routing
// logic is independently exercisable and the register-ack error-code
// branches sit in a sub-table rather than nested ifs.
//
// The factory takes the live boot context as an opts bag and returns a
// `(frame: InboundTunnelFrame) => void` ready to assign to TunnelClient.onframe.
//
// Frames the router handles:
//   * webhook-allocate-ack → webhook registry
//   * webhook              → webhook registry
//   * register-ack         → either an error sub-handler (unknown_registration_token,
//                           name_taken, or generic) or the success path
//                           (mark accepted, mark webhooks tunnel-open, persist
//                           freshly-minted token, stamp inspector header).
// Other frame types (heartbeat, rpc, manifest-delta, goodbye) are no-ops here
// — the dispatcher / heartbeat plumbing handle them on the TunnelClient itself.

import { clearRegistrationToken, writeState } from "../state.js";
import type { ConnectorState } from "../state.js";
import type { Inspector } from "../inspector/server.js";
import type { Logger } from "../logger.js";
import type { ReconnectController } from "./reconnect.js";
import type { WebhookRegistry } from "./webhook-registry.js";
import type { InboundTunnelFrame, RegisterAckFrame } from "./frames.js";

export interface FrameRouterOpts {
  webhooks: WebhookRegistry;
  state: ConnectorState;
  statePath: string;
  inspector: Inspector | undefined;
  reconnect: ReconnectController;
  log: Logger;
  // The connector name from the live yaml — surfaced in the name_taken error
  // path so the operator log carries the value they need to fix.
  connectorName: string;
}

export function createFrameRouter(opts: FrameRouterOpts): (frame: InboundTunnelFrame) => void {
  return (frame: InboundTunnelFrame) => {
    // Webhook frames go straight to the registry. Routed before register-ack
    // so a re-allocate-ack racing with the next register-ack doesn't get
    // misclassified.
    if (frame.type === "webhook-allocate-ack") {
      opts.webhooks.onAllocateAck(frame);
      return;
    }
    if (frame.type === "webhook") {
      opts.webhooks.dispatch(frame);
      return;
    }
    if (frame.type === "register-ack") {
      handleRegisterAck(frame, opts);
      return;
    }
  };
}

function handleRegisterAck(frame: RegisterAckFrame, opts: FrameRouterOpts): void {
  if (frame.error) {
    handleRegisterAckError(frame, opts);
    return;
  }
  // Success: mark accepted (clears reconnect attempts + the rejected flag),
  // open webhook delivery, persist any newly-minted token, stamp identity.
  opts.reconnect.markAccepted();
  opts.webhooks.setTunnelOpen(true);
  opts.webhooks.reallocateAll();
  if (frame.registrationToken && frame.registrationToken !== opts.state.registrationToken) {
    opts.state.registrationToken = frame.registrationToken;
    try {
      writeState(opts.state, opts.statePath);
      opts.log.info({ statePath: opts.statePath }, `register-ack ok — persisted registrationToken`);
    } catch (error) {
      opts.log.error({ err: error as Error }, `register-ack: failed to persist token`);
    }
  } else if (frame.accepted) {
    opts.log.info({ connectorId: frame.connectorId ?? "?" }, `register-ack ok — bound to existing record`);
  }
  opts.inspector?.setIdentity({ kind: "bound", tokenLen: opts.state.registrationToken?.length ?? 0 });
  // Operator-facing header. connectorId only changes on a re-mint (rare);
  // lastRegisterAckAt updates every successful ack so the operator can see
  // "this binding was confirmed N seconds ago".
  opts.inspector?.setHeader({
    ...(frame.connectorId ? { connectorId: frame.connectorId } : {}),
    lastRegisterAckAt: new Date().toISOString(),
  });
}

// Sub-table for register-ack error codes. Each branch decides whether to
// self-heal (unknown_registration_token) or hard-stop until the operator
// intervenes (name_taken / generic). The router's caller only needs the
// reconnect/inspector side-effects to land — the actual close that follows
// is driven by the controller closing the WS.
function handleRegisterAckError(frame: RegisterAckFrame, opts: FrameRouterOpts): void {
  const error = frame.error;
  if (!error) return;
  switch (error.code) {
    case "unknown_registration_token":
      // Our persisted token no longer maps to a row controller-side (DB
      // reset, row deleted, fresh volume). Clear the local token ourselves
      // and let auto-reconnect retry with no token, which the controller
      // treats as a first-connect and mints a fresh row. registrationRejected
      // stays false so onclose schedules the next attempt.
      opts.log.warn(
        { code: error.code },
        `controller no longer recognizes our registrationToken — clearing local state to re-mint on next attempt`,
      );
      opts.state.registrationToken = undefined;
      try {
        clearRegistrationToken(opts.statePath);
      } catch (clearError) {
        opts.log.error(
          { err: clearError as Error },
          `failed to clear connector-state.json — next attempt may still present a stale token`,
        );
      }
      opts.inspector?.setIdentity({ kind: "cleared" });
      return;
    case "name_taken":
      // A different connector row already owns CONNECTOR_NAME. Self-healing
      // isn't safe — silently retrying could mask a config mistake. Stay
      // sticky and log an action-oriented message.
      opts.log.error(
        { code: error.code, name: opts.connectorName },
        `name "${opts.connectorName}" is already bound to another connector row — delete that row controller-side, or change CONNECTOR_NAME and restart. auto-reconnect suppressed.`,
      );
      opts.reconnect.markRejected();
      opts.inspector?.setIdentity({
        kind: "rejected",
        reason: "name_taken",
        message: `name "${opts.connectorName}" already bound to another connector row`,
      });
      return;
    default:
      opts.log.error({ code: error.code, message: error.message }, `register-ack rejected`);
      opts.reconnect.markRejected();
      opts.inspector?.setIdentity({ kind: "rejected", reason: error.code, message: error.message });
      return;
  }
}

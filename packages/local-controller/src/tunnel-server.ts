import type { WebSocket } from "ws";
import type { TunnelFrame } from "./types.js";
import { registry } from "./registry.js";
import { logInfo, logDetail } from "./event-bus.js";

// Accept a freshly-upgraded WebSocket connection. The connector's first frame
// MUST be `register` carrying a ToolManifest; everything after that is
// driven by the manifest.connectorId we capture here.
export function acceptTunnel(ws: WebSocket): void {
  let connectorId: string | undefined;
  let registered = false;

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString("utf8");
    let frame: TunnelFrame;
    try {
      frame = JSON.parse(text) as TunnelFrame;
    } catch {
      logInfo(`malformed frame from ${connectorId ?? "<unregistered>"}`);
      return;
    }
    handleFrame(ws, frame);
  });

  ws.on("close", () => {
    if (connectorId) {
      logInfo(`connector disconnected: ${connectorId}`);
      registry.remove(connectorId);
    }
  });

  ws.on("error", (e) => {
    logInfo(`ws error from ${connectorId ?? "<unregistered>"}: ${(e as Error).message}`);
  });

  function handleFrame(socket: WebSocket, frame: TunnelFrame): void {
    if (!registered) {
      if (frame.type !== "register") {
        logInfo(`expected register frame first, got ${frame.type} — closing`);
        socket.close();
        return;
      }
      connectorId = frame.manifest.connectorId;
      registered = true;
      logInfo(`connector registered: ${connectorId} env=${frame.manifest.environment} tools=${countTools(frame.manifest)}`);
      registry.add(connectorId, socket, frame.manifest);
      return;
    }

    if (!connectorId) return; // unreachable

    switch (frame.type) {
      case "register":
        // Re-register — replace the manifest.
        logInfo(`connector re-registered: ${connectorId}`);
        registry.remove(connectorId);
        registry.add(connectorId, socket, frame.manifest);
        return;
      case "heartbeat":
        registry.heartbeat(connectorId);
        return;
      case "manifest-delta":
        logDetail(`manifest-delta from ${connectorId}: +${frame.delta.added.length}/-${frame.delta.removed.length}/~${frame.delta.changed.length}`);
        registry.applyDelta(connectorId, frame.delta);
        return;
      case "goodbye":
        logInfo(`goodbye from ${connectorId} (${frame.reason ?? "no reason"})`);
        return;
      case "rpc": {
        const payload = frame.payload as { id?: string | number; result?: unknown; error?: unknown };
        if (payload && (payload.result !== undefined || payload.error !== undefined) && payload.id != null) {
          registry.resolvePending(connectorId, payload.id, payload);
        }
        return;
      }
    }
  }
}

function countTools(m: { servers: { tools: unknown[] }[] }): number {
  return m.servers.reduce((n, s) => n + s.tools.length, 0);
}

import { registry } from "./registry.js";
import { logDetail } from "./event-bus.js";

export interface CallToolResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Send a `tools/call` to a specific connector and await its reply.
// Times out at the controller layer too (defensive: the connector has its own
// tool_timeout_ms which should fire first).
export async function callTool(
  connectorId: string,
  qualifiedName: string,
  args: Record<string, unknown> | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<CallToolResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<CallToolResult>((resolve) => {
    const id = registry.registerPending(connectorId, (resp) => {
      const r = resp as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      resolve({ result: r.result, error: r.error });
    });
    if (id === undefined) {
      resolve({ error: { code: -32000, message: `connector ${connectorId} not connected` } });
      return;
    }

    logDetail(`-> tools/call ${connectorId}:${qualifiedName} id=${id}`);
    const ok = registry.send(connectorId, {
      type: "rpc",
      payload: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: qualifiedName, arguments: args ?? {} },
      },
    });
    if (!ok) {
      registry.cancelPending(connectorId, id);
      resolve({ error: { code: -32000, message: "send failed" } });
      return;
    }

    setTimeout(() => {
      registry.cancelPending(connectorId, id);
      resolve({ error: { code: -32001, message: `controller timeout after ${timeoutMs}ms` } });
    }, timeoutMs);
  });
}

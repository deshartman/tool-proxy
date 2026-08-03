// Decorator over McpServerConnection that records every request sent to
// (and response / error / notification received from) an MCP child, for
// the inspector's MCP Status → message-history pane.
//
// Wrapping happens exactly once, in boot/lifecycle.ts's onConnect hook,
// and the WRAPPED object replaces the raw connection in the shared
// `servers` map — so dispatcher.ts, manifest/build.ts, and the inspector's
// own tool-runner all see tapped traffic with no change on their part,
// since they all read connections out of that same map.
import type { McpServerConnection, ServerNotification } from "./index.js";

export interface McpMessageTap {
  mcp: string;
  direction: "out" | "in";
  kind: "request" | "response" | "error" | "notification";
  method: string;
  payload: unknown;
  ts: number;
}

export function wrapWithMessageTap(
  mcp: string,
  connection: McpServerConnection,
  record: (tap: McpMessageTap) => void,
): McpServerConnection {
  // Wrap one request/response method: record the call args as an "out"
  // tap, then the eventual result (or error) as an "in" tap.
  function tapped<Args extends unknown[], R>(
    method: string,
    fn: (...args: Args) => Promise<R>,
  ): (...args: Args) => Promise<R> {
    return async (...args: Args) => {
      record({ mcp, direction: "out", kind: "request", method, payload: args, ts: Date.now() });
      try {
        const result = await fn(...args);
        record({ mcp, direction: "in", kind: "response", method, payload: result, ts: Date.now() });
        return result;
      } catch (err) {
        record({
          mcp, direction: "in", kind: "error", method,
          payload: { message: (err as Error).message }, ts: Date.now(),
        });
        throw err;
      }
    };
  }

  return {
    ...connection,
    listTools: tapped("listTools", connection.listTools.bind(connection)),
    callTool: tapped("callTool", connection.callTool.bind(connection)),
    listPrompts: tapped("listPrompts", connection.listPrompts.bind(connection)),
    getPrompt: tapped("getPrompt", connection.getPrompt.bind(connection)),
    listResources: tapped("listResources", connection.listResources.bind(connection)),
    listResourceTemplates: tapped("listResourceTemplates", connection.listResourceTemplates.bind(connection)),
    readResource: tapped("readResource", connection.readResource.bind(connection)),
    subscribeResource: tapped("subscribeResource", connection.subscribeResource.bind(connection)),
    unsubscribeResource: tapped("unsubscribeResource", connection.unsubscribeResource.bind(connection)),
    complete: tapped("complete", connection.complete.bind(connection)),
    setLoggingLevel: tapped("setLoggingLevel", connection.setLoggingLevel.bind(connection)),
    onNotification(handler: (n: ServerNotification) => void) {
      return connection.onNotification((n) => {
        record({ mcp, direction: "in", kind: "notification", method: n.method, payload: n.params, ts: Date.now() });
        handler(n);
      });
    },
  };
}

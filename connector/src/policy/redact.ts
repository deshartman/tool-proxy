import type { ConnectorConfig } from "../config.js";
import type { McpMessageTap } from "../servers/message-tap.js";

type LogPolicy = ConnectorConfig["policy"]["log_tool_args"];

// Renders tool-call args for logging per `policy.log_tool_args`. Used at the
// dispatcher's logging point only; never alters what's sent over the wire.
export function renderArgsForLog(args: unknown, policy: LogPolicy): string {
  switch (policy) {
    case "none":     return "<args hidden>";
    case "full":     return safeStringify(args);
    case "redacted":
    default:         return redact(args);
  }
}

function redact(args: unknown): string {
  if (args == null) return "<no args>";
  if (typeof args !== "object") return "<redacted>";
  const out: Record<string, string> = {};
  for (const key of Object.keys(args as Record<string, unknown>)) {
    out[key] = "<redacted>";
  }
  return safeStringify(out);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

// ── Inspector message tap (MCP-AUDIT #10) ─────────────────────────────────────
// The tap feeds the inspector's MCP Status → message-history pane, which exists
// so a developer can see exactly what went into a tool and what came back. The
// dispatcher's log line for the same call goes through renderArgsForLog above,
// so the two surfaces could disagree — and they deliberately still do at the
// DEFAULT setting, because the surfaces have different threat models:
//
//   * the log stream is durable, leaves the box, and is read by people who are
//     not the operator — hence `redacted` is its default.
//   * the tap is in-memory, capped, cleared on restart, and served loopback-only
//     to the developer who is actively debugging. Redacting it at the default
//     would break the feature for everyone who never chose a setting.
//
// `none` is different in kind: nobody arrives at it by accident, so it is read
// as "do not record tool arguments anywhere" and honoured here too. Scoped to
// REQUEST payloads, matching what the knob is named after — a result is not an
// argument, and `log_tool_args` makes no claim about it.
//
// docs/INSPECTOR.md §"Message history" states the `redacted`-shows-cleartext
// exemption plainly, which is the other half of this finding.
export function redactTapPayload(
  tap: McpMessageTap,
  policy: LogPolicy,
): McpMessageTap {
  if (policy !== "none") return tap;
  if (tap.kind !== "request") return tap;
  return { ...tap, payload: "<args hidden by policy.log_tool_args=none>" };
}

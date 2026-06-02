import type { ConnectorConfig } from "../config.js";

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
  for (const k of Object.keys(args as Record<string, unknown>)) {
    out[k] = "<redacted>";
  }
  return safeStringify(out);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

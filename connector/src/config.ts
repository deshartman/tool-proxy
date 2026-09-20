import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parse as parseDotenv } from "dotenv";
import type { McpAuthSpec } from "./tunnel/frames.js";

const HttpServer = z.object({
  name: z.string().min(1),
  transport: z.literal("http"),
  // endpoint is optional: when absent and `dir` is set, the connector spawns
  // the folder as a Type 1 child and synthesizes endpoint at an auto-assigned
  // localhost port.
  endpoint: z.string().url().optional(),
  dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Optional outbound headers attached to every JSON-RPC POST to `endpoint`.
  // Set by the supervisor (W-E3) on every spawn when a 3rd-party MCP entry
  // carries an `auth` shape — the supervisor calls resolveAuthHeaders() with
  // controller-supplied env values and stamps the result here. Not yaml-
  // configurable today. Passed through to StreamableHTTPClientTransport via
  // requestInit.headers in src/servers/http.ts.
  headers: z.record(z.string(), z.string()).optional(),
  // Auth shape for HTTP-family 3rd-party MCPs (W-E3). Carried opaquely on the
  // spec by the controller-config coordinator; the supervisor resolves it to
  // `headers` at spawn time. Yaml entries leave this undefined (yaml has no
  // surface for it; auth on Type 1 / Type 2 yaml entries comes from per-spec
  // env or upstream URL embedding).
  auth: z.custom<McpAuthSpec>().optional(),
  timeout_ms: z.number().int().positive().default(5000),
});

const StdioServer = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
  dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().default(5000),
});

// Auto-reconnect: when the WS closes unexpectedly (not from a manual reconnect
// or SIGTERM) the connector schedules a redial on a backoff timer instead of
// sitting idle. Disable this in environments where the orchestrator is the
// supervisor (e.g. a Fargate task with a healthcheck and restart policy) and
// you'd rather have the process exit-and-be-restarted than auto-recover.
// max_attempts=0 means infinite retries.
const ReconnectPolicy = z.object({
  enabled: z.boolean().default(true),
  initial_backoff_ms: z.number().int().positive().default(1_000),
  max_backoff_ms: z.number().int().positive().default(30_000),
  max_attempts: z.number().int().nonnegative().default(0),
});

const Policy = z.object({
  fail_mode: z.literal("fail_fast").default("fail_fast"),
  log_tool_args: z.enum(["none", "redacted", "full"]).default("redacted"),
  max_concurrent_calls: z.number().int().positive().default(64),
  discovery_interval_ms: z.number().int().positive().default(30_000),
  heartbeat_interval_ms: z.number().int().positive().default(1_500),
  tool_timeout_ms: z.number().int().positive().default(5_000),
  reconnect: ReconnectPolicy.default(() => ReconnectPolicy.parse({})),
});

export type ReconnectPolicyConfig = z.infer<typeof ReconnectPolicy>;

const ConfigSchema = z.object({
  // The tunnel: block is legacy — retained in the schema so old
  // connector.yaml files parse cleanly, but bootFromDb ignores its contents
  // entirely (tunnel identity + creds live in the sealed config store).
  // Empty strings on controller_url / name pass validation so
  // `${CONTROLLER_URL:-}` yaml interpolations don't break parsing.
  tunnel: z
    .object({
      // Legacy — see block comment above. Preprocess handles the yaml quirk
      // where `key: ${VAR:-}` (unset var) interpolates to a bare `key: `
      // which YAML parses as null, not "".
      controller_url: z.preprocess(
        (v) => (v === null ? "" : v),
        z.string().url().or(z.literal("")),
      ),
      // Customer-chosen connector name. Used as the identity claim on first
      // connect — the controller mints a fresh row keyed to this name and
      // returns a registrationToken which the connector persists in
      // .connector-state.json. Subsequent connects identify by token; the name
      // is along for the ride (logs, controller UI).
      name: z.preprocess(
        (v) => (v === null ? "" : v),
        z.string(),
      ),
      auth_token: z
        .string()
        .nullable()
        .optional()
        .transform((v) => (v == null || v === "" ? undefined : v)),
      account_sid: z.string().optional(),
      environment: z.string().default("dev"),
      region: z.string().optional(),
      credentials_file: z.string().optional(),
    })
    .optional(),
  // Empty array is allowed — and is the normal case. Drop-ins are
  // auto-discovered under MCP_DROPIN_DIR / MCP_BUNDLED_DIR, and Type 2 MCPs
  // arrive as a controller-pushed roster over the WS at register-ack. The
  // yaml only owns hand-written Type 1 servers, which most deployments do
  // not use. Default so an omitted `mcp_servers:` key is also accepted.
  mcp_servers: z
    .array(z.discriminatedUnion("transport", [HttpServer, StdioServer]))
    .default(() => []),
  policy: Policy.default(() => Policy.parse({})),
});

export type ConnectorConfig = z.infer<typeof ConfigSchema>;
export type McpServerSpec = z.infer<typeof HttpServer> | z.infer<typeof StdioServer>;

// True when the entry is a Type 1 customer-authored MCP that the connector
// must spawn as a child process. Detection: http transport + dir set +
// endpoint omitted. (Type 2 http entries set endpoint; Type 2 stdio entries
// use the stdio transport.)
export function isType1Spawn(spec: McpServerSpec): spec is z.infer<typeof HttpServer> & { dir: string } {
  return spec.transport === "http" && !!spec.dir && !spec.endpoint;
}

// Derive the MCP's author from its spec — surfaced on the wire as
// ServerDescriptor.author so the controller can group Twilio-shipped MCPs
// separately from customer-authored ones in the UI. One classifier: Type 1
// drop-ins discovered under MCP_BUNDLED_DIR are tagged by the scanner via
// the __author marker on DropinSpec (see dropin.ts). Everything else is
// "customer".
//
// Two earlier classifier branches were retired: a `dir:` → `mcp/bundled/`
// path sniff (with the bundled-twilio MCP, 2026-06-30) and a stdio +
// `bundled:` check (with the Python-venv bundle mechanism, 2026-08-23).
// Third-party MCPs arrive as Type 2 controller-config entries which the
// controller already tags author-side, so no path-sniffing is required.
export function authorOf(spec: McpServerSpec): string {
  if ((spec as { __author?: string }).__author === "twilio") return "twilio";
  return "customer";
}

export function loadConfig(configPath: string): ConnectorConfig {
  const absolute = resolve(configPath);
  const raw = readFileSync(absolute, "utf8");
  const interpolated = interpolateEnv(raw, absolute);
  const parsed = parse(interpolated);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid connector config at ${absolute}:\n${issues}`);
  }
  // Resolve each entry's `dir` against the YAML's directory, then layer in
  // <dir>/.env on top of the inline yaml `env:` (yaml takes precedence).
  // This populates a per-entry env map without mutating process.env, so
  // entries can carry overlapping var names (e.g. each its own PORT or
  // service token) without leaking across children.
  const yamlDir = dirname(absolute);
  for (const spec of result.data.mcp_servers) {
    if (spec.dir) {
      spec.dir = resolve(yamlDir, spec.dir);
      const dotenvPath = resolve(spec.dir, ".env");
      if (existsSync(dotenvPath)) {
        const fromFile = parseDotenv(readFileSync(dotenvPath, "utf8"));
        spec.env = spec.env ? { ...fromFile, ...spec.env } : fromFile;
      }
    }
  }
  return result.data;
}

// Substitute ${VAR} and ${VAR:-default} from process.env. Unknown vars without
// a default throw with the var name + 1-based YAML line so the customer can
// fix the right line.
//
// Full-line yaml comments (lines whose first non-whitespace character is `#`)
// are treated as inert — the interpolator does NOT match ${VAR} inside them.
// This aligns with yaml's own semantics (comments never affect parsed state)
// and prevents a class of bugs where a documentation comment mentioning
// `${CONTROLLER_URL}` hard-fails boot when the customer hasn't set that var.
// See ENV-TO-DB.md §"Post-Step-12 runtime discoveries" entry G for the
// retrospective this fix comes from.
function interpolateEnv(raw: string, source: string): string {
  const pattern = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;
  return raw
    .split("\n")
    .map((line, idx) => {
      // Skip lines whose first non-whitespace char is `#` — pure yaml comments.
      // Inline comments (`key: value # inline`) are NOT skipped; that case is
      // rare in the connector yaml surface and if it did carry a bare ${VAR}
      // it would still throw (correctly, since the value slice is what yaml
      // parses). Keeping the inline case strict avoids a fragile string-quote-
      // aware `#` scanner in this pre-parse pass.
      if (line.trimStart().startsWith("#")) return line;
      return line.replaceAll(pattern, (_match, name: string, fallback: string | undefined) => {
        const value = process.env[name];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback;
        // idx is 0-based; yaml editors show 1-based lines.
        throw new Error(`Missing env var \${${name}} at ${source}:${idx + 1}`);
      });
    })
    .join("\n");
}

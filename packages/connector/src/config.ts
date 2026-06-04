import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parse as parseDotenv } from "dotenv";

const HttpServer = z.object({
  name: z.string().min(1),
  transport: z.literal("http"),
  // endpoint is optional: when absent and `dir` is set, the connector spawns
  // the folder as a Type 1 child and synthesizes endpoint at an auto-assigned
  // localhost port.
  endpoint: z.string().url().optional(),
  dir: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().default(5000),
});

const StdioServer = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
  dir: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout_ms: z.number().int().positive().default(5000),
});

const Policy = z.object({
  fail_mode: z.literal("fail_fast").default("fail_fast"),
  log_tool_args: z.enum(["none", "redacted", "full"]).default("redacted"),
  max_concurrent_calls: z.number().int().positive().default(64),
  discovery_interval_ms: z.number().int().positive().default(30_000),
  heartbeat_interval_ms: z.number().int().positive().default(1_500),
  tool_timeout_ms: z.number().int().positive().default(5_000),
});

const ConfigSchema = z.object({
  tunnel: z.object({
    // The controller's HTTPS root. Used for the WS tunnel dial — the
    // connector upgrades https:// → wss:// internally in tunnel/client.ts.
    controller_url: z.string().url(),
    // Optional override for the WS tunnel dial. Use this in setups where the
    // tunnel listener is on a different host than the API (e.g. the dev rig
    // where two ngrok tunnels front 3001 and 3002 separately). Production is
    // typically one host — leave this unset and let the rewrite handle it.
    ws_url: z
      .string()
      .url()
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? undefined : v)),
    // Customer-chosen connector name. Used as the identity claim on first
    // connect — the controller mints a fresh row keyed to this name and
    // returns a registrationToken which the connector persists in
    // .connector-state.json. Subsequent connects identify by token; the name
    // is along for the ride (logs, controller UI).
    name: z.string().min(1),
    auth_token: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? undefined : v)),
    account_sid: z.string().optional(),
    environment: z.string().default("dev"),
    region: z.string().optional(),
    credentials_file: z.string().optional(),
  }),
  mcp_servers: z.array(z.discriminatedUnion("transport", [HttpServer, StdioServer])).min(1),
  policy: Policy.default({}),
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

export function loadConfig(configPath: string): ConnectorConfig {
  const absolute = resolve(configPath);
  const raw = readFileSync(absolute, "utf8");
  const interpolated = interpolateEnv(raw, absolute);
  const parsed = parse(interpolated);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
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
function interpolateEnv(raw: string, source: string): string {
  const pattern = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;
  return raw.replaceAll(pattern, (_match, name: string, fallback: string | undefined, offset: number) => {
    const value = process.env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    const line = raw.slice(0, offset).split("\n").length;
    throw new Error(`Missing env var \${${name}} at ${source}:${line}`);
  });
}

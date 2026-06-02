import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const HttpServer = z.object({
  name: z.string().min(1),
  transport: z.literal("http"),
  endpoint: z.string().url(),
  timeout_ms: z.number().int().positive().default(5000),
});

const StdioServer = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
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
    controller_url: z.string().url(),
    connector_id: z.string().min(1),
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

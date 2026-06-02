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
    account_sid: z.string().optional(),
    environment: z.string().default("dev"),
    region: z.string().optional(),
    credentials_file: z.string().optional(),
  }),
  mcp_servers: z.array(z.discriminatedUnion("transport", [HttpServer, StdioServer])).min(1),
  allow_list: z.object({ tools: z.array(z.string()) }).optional(),
  policy: Policy.default({}),
});

export type ConnectorConfig = z.infer<typeof ConfigSchema>;
export type McpServerSpec = z.infer<typeof HttpServer> | z.infer<typeof StdioServer>;

export function loadConfig(configPath: string): ConnectorConfig {
  const absolute = resolve(configPath);
  const raw = readFileSync(absolute, "utf8");
  const parsed = parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid connector config at ${absolute}:\n${issues}`);
  }
  return result.data;
}

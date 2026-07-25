import { envOptional } from "../env.js";

export type CredsSource = "env" | "db";

export function resolveCredsSource(env: NodeJS.ProcessEnv = process.env): CredsSource {
  const raw = envOptional("CONNECTOR_CREDS_SOURCE", env) ?? "db";
  if (raw !== "env" && raw !== "db") {
    throw new Error(`CONNECTOR_CREDS_SOURCE must be "env" or "db"; got "${raw}"`);
  }
  return raw;
}

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { envString } from "../env.js";

export interface MasterKey {
  bytes: Buffer;         // exactly 32 bytes
  fingerprint: string;   // sha256 hex
}

export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): MasterKey {
  const path = envString("CONNECTOR_KEY_FILE", "", env);
  if (!path) throw new Error("CONNECTOR_KEY_FILE is required (path to a 32-byte master key file, mode 0600).");
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if (mode & 0o077) throw new Error(`CONNECTOR_KEY_FILE at ${path} has mode ${mode.toString(8)}; must be 0600.`);
  const bytes = readFileSync(path);
  if (bytes.length !== 32) throw new Error(`CONNECTOR_KEY_FILE at ${path} must be exactly 32 bytes (got ${bytes.length}).`);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  return { bytes, fingerprint };
}

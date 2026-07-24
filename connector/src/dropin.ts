// Drop-in MCP discovery (W-A1 / W-A2 of MCP-LOADING).
//
// Scans MCP_DROPIN_DIR for folders containing a tools/ subdirectory and
// synthesizes Type 1 specs the supervisor can spawn. The scanner skips:
//   * folders that already have server.ts (hand-written Type 1; the
//     customer authored boilerplate deliberately and we don't second-guess)
//   * folders whose name is already declared in connector.yaml (yaml entry
//     wins so a migration from hand-written Type 1 to drop-in is incremental)
//
// MCP_DROPIN_DIR resolution:
//   * Production (OCI image): /var/lib/mcp-connector/customer-mcps/
//     Customers land Type 1 MCPs at this path via one of two supported
//     patterns: derived image (`FROM twilio/mcp-connector` + `COPY`) or
//     volume mount (K8s ConfigMap / PVC, Fly volume, AWS EFS, Azure
//     Files, docker-compose bind mount). See docs/deploy/DERIVED-IMAGE.md
//     and docs/deploy/VOLUME-MOUNT.md.
//   * Local dev: defaults to mcp/local/ relative to the connector package
//     so the bundled `sample` drop-in works without a new mount.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import type { McpServerSpec } from "./config.js";
import { envOptional } from "./env.js";

// ESM equivalent of CJS `__dirname`. At runtime this resolves to the
// compiled `dist/` directory because tsc preserves file structure under
// outDir.
const here = dirname(fileURLToPath(import.meta.url));

export interface DropinDiscoveryOpts {
  // Names already declared in connector.yaml — these win over drop-in
  // discovery for the same folder name.
  yamlNames: Set<string>;
  // Override the resolved dropin dir (tests). Defaults to
  // process.env.MCP_DROPIN_DIR or the platform default below.
  dropinDir?: string;
  // Where mcp/local/ lives, used for the local-dev default. Tests pass an
  // absolute path; production callers pass the connector package root so
  // dist/ can resolve up two levels to the repo root.
  localDevRoot?: string;
}

// Drop-in specs are an internal extension of Type 1 (http + dir + no
// endpoint at boot, populated by the supervisor on spawn). Keep the shape
// assignable to McpServerSpec so connectServer accepts it directly.
// __author flags the origin scanner: "twilio" for entries from bundled-mcps/
// (Twilio-shipped MCPs, always on), otherwise a customer drop-in.
export type DropinSpec = Extract<McpServerSpec, { transport: "http" }> & {
  __dropin: true;
  __author?: "twilio" | "customer";
};

const DROPIN_PROD_DEFAULT = "/var/lib/mcp-connector/customer-mcps";
const BUNDLED_PROD_DEFAULT = "/app/bundled-mcps";

export function resolveDropinDir(opts: DropinDiscoveryOpts): string | undefined {
  const explicit = opts.dropinDir ?? envOptional("MCP_DROPIN_DIR");
  if (explicit) return resolve(explicit);
  // Production-image default. Local dev overrides via start-connector.sh
  // which exports MCP_DROPIN_DIR=customer-mcps before exec.
  return DROPIN_PROD_DEFAULT;
}

// MCP_BUNDLED_DIR resolution mirrors MCP_DROPIN_DIR. Production image bakes
// this at /app/bundled-mcps (the Dockerfile COPYs bundled-mcps/ there);
// local dev overrides via start-connector.sh which exports MCP_BUNDLED_DIR
// pointing at the working tree's bundled-mcps/.
export function resolveBundledDir(opts: { bundledDir?: string } = {}): string | undefined {
  const explicit = opts.bundledDir ?? envOptional("MCP_BUNDLED_DIR");
  if (explicit) return resolve(explicit);
  return BUNDLED_PROD_DEFAULT;
}

export function discoverDropins(opts: DropinDiscoveryOpts): DropinSpec[] {
  const dir = resolveDropinDir(opts);
  return scanFolder(dir, opts.yamlNames, "customer");
}

// Discover Twilio-shipped bundled MCPs. D1 (always on): every valid folder
// under MCP_BUNDLED_DIR registers unconditionally — no allowlist parameter,
// no env-var gate. Customers who explicitly don't want a bundled MCP remove
// its folder from their derived image or unmount it. Type 3 (Python venv)
// bundles put source under bundled-mcps/<name>/source/; the Node-side spec
// only carries dir: <folder> for per-entry .env merging, so the scanner
// picks them up only if the folder itself has a tools/ subdir (Node bundle).
// Type 3 bundles opt in via BUNDLED_MCPS in config.ts + a yaml entry
// (transitional) or a future auto-registration path, not through this
// scanner.
export function discoverBundled(opts: { bundledDir?: string; yamlNames: Set<string> }): DropinSpec[] {
  const dir = resolveBundledDir(opts);
  return scanFolder(dir, opts.yamlNames, "twilio");
}

// Shared folder-scan logic. author marks whether specs come from the
// customer drop-in dir or the Twilio-shipped bundled dir; the value threads
// into authorOf via the __author marker.
function scanFolder(
  dir: string | undefined,
  yamlNames: Set<string>,
  author: "twilio" | "customer",
): DropinSpec[] {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: DropinSpec[] = [];
  for (const name of readdirSync(dir)) {
    const folder = resolve(dir, name);
    if (!statSync(folder).isDirectory()) continue;
    if (yamlNames.has(name)) continue;          // yaml entry wins
    if (existsSync(resolve(folder, "server.ts"))) continue; // hand-written Type 1 wins
    const toolsDir = resolve(folder, "tools");
    if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) continue;
    if (!hasToolFiles(toolsDir)) continue;
    const env = loadDropinEnv(folder);
    const spec: DropinSpec = {
      name,
      transport: "http",
      dir: folder,
      timeout_ms: 5000,
      ...(env ? { env } : {}),
      __dropin: true,
      __author: author,
    };
    out.push(spec);
  }
  return out;
}

function hasToolFiles(toolsDir: string): boolean {
  for (const entry of readdirSync(toolsDir)) {
    if (entry.endsWith(".ts") || entry.endsWith(".js")) return true;
  }
  return false;
}

// Load <folder>/.env into a per-spec env map (mirrors loadConfig's per-entry
// env behavior so dropin folders can carry the same dir/.env fallback).
function loadDropinEnv(folder: string): Record<string, string> | undefined {
  const path = resolve(folder, ".env");
  if (!existsSync(path)) return undefined;
  const parsed = parseDotenv(readFileSync(path, "utf8"));
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

// Marker check used by the supervisor.
export function isDropinSpec(spec: McpServerSpec | DropinSpec): spec is DropinSpec {
  return (spec as DropinSpec).__dropin === true;
}

// Resolve the absolute path to the compiled dropin-runner.js. Used by the
// supervisor to launch a synthesized server.
export function dropinRunnerPath(): string {
  // `here` at runtime is dist/; the runner sits at dist/sdk/dropin-runner.js.
  return resolve(here, "sdk", "dropin-runner.js");
}

// Helper for callers that need to feed the supervisor a uniform list:
// returns the directory the connector package itself lives in. Used as
// the dev-only fallback when MCP_DROPIN_DIR is unset; production
// customers always either set MCP_DROPIN_DIR or land MCPs at
// PROD_DEFAULT (see resolution comment above).
export function connectorPackageRoot(): string {
  // `here` at runtime is dist/; up one to connector/.
  return dirname(here);
}

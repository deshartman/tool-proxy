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
//   * Production (OCI image): /var/lib/tool-proxy/customer-mcps/
//     Customers land Type 1 MCPs at this path via one of two supported
//     patterns: derived image (`FROM ghcr.io/twilio-demos/tool-proxy` + `COPY`) or
//     volume mount (K8s ConfigMap / PVC, Fly volume, AWS EFS, Azure
//     Files, docker-compose bind mount). See deploy/DERIVED-IMAGE.md
//     and deploy/VOLUME-MOUNT.md.
//   * Local dev: scripts/start-connector.sh exports MCP_DROPIN_DIR pointing at
//     the working tree's customer-mcps/. There is no implicit local-dev
//     fallback — resolveDropinDir returns DROPIN_PROD_DEFAULT when the env var
//     is unset.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { SERVER_NAME_RE } from "./identity/server-name.js";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import type { McpServerSpec } from "./config.js";
import { envOptional } from "./env.js";
import { createLogger } from "./logger.js";

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
}

// Drop-in specs are an internal extension of Type 1 (http + dir + no
// endpoint at boot, populated by the supervisor on spawn). Keep the shape
// assignable to McpServerSpec so connectServer accepts it directly.
// __author flags the origin scanner: "twilio" for entries from bundled-mcps/
// (Twilio-shipped MCPs, always on), otherwise a customer drop-in.
export type DropinSpec = Extract<McpServerSpec, { transport: "http" }> & {
  __dropin: true;
  __author?: "twilio" | "customer";
  // A demo, not a production MCP. Set when the folder carries an `.example`
  // marker file. Nothing else distinguishes a demo from agentic-memory: the
  // image copies examples/demos/* into bundled-mcps/ alongside it. Reaches
  // the platform as mcp-discovered.kind so its pending lane can label demos.
  __example?: true;
};

// The marker file that flags a folder as a demo (see DropinSpec.__example).
export const EXAMPLE_MARKER = ".example";

const log = createLogger("dropin");

// MCP-AUDIT #31 — discovery must not leave the directory it was pointed at.
// statSync/existsSync follow symlinks, so a directory symlink inside the drop-in
// dir is followed transparently and any tools/*.{ts,js} beneath it gets imported
// and spawned.
//
// The threat is a PRIVILEGE SPLIT, not an attacker who can already write here
// (they would just drop a .ts file directly): a read-only mount — a ConfigMap, a
// baked derived image — is treated as reviewed, but a symlink committed into it
// points at a writable path (/tmp, a scratch volume, a log dir). The reviewed
// artifact then runs unreviewed code, and no diff of the mount shows it.
//
// Enforced by default. The escape hatch exists because the documented dev
// workflow symlinks examples/demos/<name> into customer-mcps/<name>, which is
// legitimately outside the drop-in root; scripts/start-connector.sh sets it.
// Do NOT set it in a deployed container.
const ALLOW_SYMLINK_ESCAPE_ENV = "MCP_DROPIN_ALLOW_SYMLINK_ESCAPE";

function symlinkEscapeAllowed(): boolean {
  return envOptional(ALLOW_SYMLINK_ESCAPE_ENV) === "1";
}

// MCP-AUDIT #16 — the folder name becomes the MCP name verbatim, and the
// dispatcher routes on the FIRST dot: `qualifiedName.indexOf(".")` splits
// `${server}.${tool}`. So a folder named `acme.crm` yields `acme.crm.get_customer`,
// which splits to server `acme` / tool `crm.get_customer` — `tool_not_found` for
// every tool in the folder, with nothing anywhere explaining why. Whitespace and
// non-ASCII names were accepted just as silently.
//
// The shared server-name rule (identity/server-name.ts) — the same one yaml
// and controller-pushed names now go through. Widening it means re-checking
// the dispatcher's split.
const MCP_NAME_RE = SERVER_NAME_RE;

const DROPIN_PROD_DEFAULT = "/var/lib/tool-proxy/customer-mcps";
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
// its folder from their derived image or unmount it. A folder is picked up
// only if it has a tools/ subdir, i.e. it is a Node drop-in.
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
  // Real path of the root, for the containment check below. A symlinked root is
  // fine — it is the operator's own choice of where to point us.
  let root: string;
  try {
    root = realpathSync(dir);
  } catch (err) {
    log.error({ dir, err: err as Error }, `cannot resolve drop-in dir — skipping discovery`);
    return [];
  }
  const allowEscape = symlinkEscapeAllowed();
  for (const name of readdirSync(dir)) {
    const folder = resolve(dir, name);
    // MCP-AUDIT #7: statSync follows symlinks and THROWS on a dangling one. This
    // was unguarded, and neither call site wraps the function — so one broken
    // symlink meant ZERO MCPs discovered (at boot and on rescan), surfacing as a
    // boot crash rather than "your drop-ins are missing". Skip the entry, not the
    // scan — and say so, because a dangling link is a misconfiguration the
    // operator wants to know about, not something to swallow silently.
    let real: string;
    let isDir = false;
    try {
      real = realpathSync(folder);
      isDir = statSync(folder).isDirectory();
    } catch (err) {
      log.warn(
        { folder, err: (err as Error).message },
        `drop-in entry could not be resolved (dangling symlink or raced deletion) — skipping this entry`,
      );
      continue;
    }
    if (!isDir) continue;
    // MCP-AUDIT #31: containment. See ALLOW_SYMLINK_ESCAPE_ENV above.
    if (real !== root && !real.startsWith(root + sep)) {
      if (!allowEscape) {
        log.warn(
          { folder, resolvedTo: real, root, allowVia: ALLOW_SYMLINK_ESCAPE_ENV },
          `drop-in folder resolves OUTSIDE the drop-in dir — skipping (set ${ALLOW_SYMLINK_ESCAPE_ENV}=1 for the symlink-based dev workflow)`,
        );
        continue;
      }
      log.debug({ folder, resolvedTo: real }, `drop-in folder resolves outside the drop-in dir — allowed by ${ALLOW_SYMLINK_ESCAPE_ENV}`);
    }
    // MCP-AUDIT #16: reject unroutable names before they become MCP names.
    if (!MCP_NAME_RE.test(name)) {
      log.warn(
        { folder, name },
        `drop-in folder name is not a valid MCP name (letters, digits, dash, underscore; no dots) — skipping`,
      );
      continue;
    }
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
      ...(existsSync(resolve(folder, EXAMPLE_MARKER)) ? { __example: true as const } : {}),
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

// Synthesized server runtime for drop-in MCP folders. The connector spawns
// this when a customer drops a folder at MCP_DROPIN_DIR/<name>/tools/*.ts
// without authoring a server.ts of their own. The folder name is the MCP
// name; every default-exported (or named) `Tool` in tools/*.ts is auto-
// registered.
//
// One process per dropin folder so a misbehaving tool can't crash the
// connector — same crash-isolation property as today's hand-written Type 1
// children. See .claude/plans/MCP-LOADING.md (W-A2).

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpHttpServer } from "./http-server.js";
import type { Tool } from "./tool.js";
import { createLogger } from "../logger.js";

async function main(): Promise<void> {
  const dir = process.env.DROPIN_DIR;
  const name = process.env.DROPIN_NAME;
  if (!dir || !name) {
    process.stderr.write("dropin-runner: DROPIN_DIR and DROPIN_NAME must be set\n");
    process.exit(2);
  }
  const log = createLogger(`dropin:${name}`);
  const toolsDir = resolvePath(dir, "tools");
  if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) {
    log.error({ toolsDir }, `dropin folder has no tools/ subdirectory — nothing to register`);
    process.exit(2);
  }
  const tools: Tool[] = [];
  const entries = readdirSync(toolsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  for (const entry of entries) {
    const full = resolvePath(toolsDir, entry);
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const tool = pickTool(mod);
      if (tool && !tools.some((t) => t.name === tool.name)) tools.push(tool);
      else if (!tool) log.warn({ file: entry }, `no Tool default-export found — skipping`);
    } catch (err) {
      log.error({ file: entry, err: err as Error }, `failed to import tool file`);
    }
  }
  if (tools.length === 0) {
    log.error(`no tools registered from ${toolsDir} — exiting`);
    process.exit(2);
  }
  await createMcpHttpServer({ name, tools });
}

// Prefer the default export; fall back to the first named export that has
// the Tool shape. Matches the authoring convention of one Tool per file.
function pickTool(mod: Record<string, unknown>): Tool | undefined {
  if (isToolShape(mod.default)) return mod.default;
  for (const value of Object.values(mod)) {
    if (isToolShape(value)) return value;
  }
  return undefined;
}

function isToolShape(value: unknown): value is Tool {
  return typeof value === "object"
    && value !== null
    && typeof (value as Tool).name === "string"
    && typeof (value as Tool).register === "function";
}

void main().catch((err) => {
  process.stderr.write(`dropin-runner: ${(err as Error).message}\n`);
  process.exit(1);
});

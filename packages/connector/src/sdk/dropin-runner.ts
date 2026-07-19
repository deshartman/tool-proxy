// Synthesized server runtime for drop-in MCP folders. The connector spawns
// this when a customer drops a folder at MCP_DROPIN_DIR/<name>/{tools,prompts,
// resources}/*.ts without authoring a server.ts of their own. The folder name
// is the MCP name; every default-exported (or named) Tool / Prompt / Resource
// in the matching subdirectory is auto-registered.
//
// One process per dropin folder so a misbehaving tool can't crash the
// connector — same crash-isolation property as today's hand-written Type 1
// children. See .claude/plans/MCP-LOADING.md (W-A2) and the v1.2
// prompts/resources extension in .claude/plans/MCP-CLIENT-USE.md. The
// scanning logic itself lives in dropin-discovery.ts so it can be tested
// without spawning a real child process.

import { createMcpHttpServer } from "./http-server.js";
import {
  loadCategory,
  loadCapabilities,
  isToolShape,
  isPromptShape,
  isResourceShape,
} from "./dropin-discovery.js";
import type { Tool } from "./tool.js";
import type { Prompt } from "./prompt.js";
import type { Resource } from "./resource.js";
import { createLogger } from "../logger.js";

async function main(): Promise<void> {
  const dir = process.env.DROPIN_DIR;
  const name = process.env.DROPIN_NAME;
  if (!dir || !name) {
    process.stderr.write("dropin-runner: DROPIN_DIR and DROPIN_NAME must be set\n");
    process.exit(2);
  }
  const log = createLogger(`dropin:${name}`);

  const tools     = await loadCategory<Tool>(dir,     "tools",     "tool",     isToolShape,     log);
  const prompts   = await loadCategory<Prompt>(dir,   "prompts",   "prompt",   isPromptShape,   log);
  const resources = await loadCategory<Resource>(dir, "resources", "resource", isResourceShape, log);
  // Optional per-folder capabilities.ts. Missing file → undefined; the
  // factory's default behavior is unchanged. Present → merged into the MCP
  // initialize response via the factory's `capabilities` option. Custom
  // shapes MUST live under `experimental` / `extensions` (see the docstring
  // on CreateMcpHttpServerOptions.capabilities).
  const capabilities = await loadCapabilities(dir, log);

  if (tools.length === 0 && prompts.length === 0 && resources.length === 0) {
    log.error({ dir }, `no tools / prompts / resources registered — exiting`);
    process.exit(2);
  }
  await createMcpHttpServer({ name, tools, prompts, resources, capabilities });
}

void main().catch((err) => {
  process.stderr.write(`dropin-runner: ${(err as Error).message}\n`);
  process.exit(1);
});

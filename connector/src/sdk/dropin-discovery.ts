// File-system scanning for the synthesized drop-in runtime. Lifted out of
// dropin-runner.ts so the discovery logic is testable without spawning a
// real child process. The runner imports these and calls main(); a vitest
// can import the same helpers and feed them fixture folders.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tool } from "./tool.js";
import type { Prompt } from "./prompt.js";
import type { Resource } from "./resource.js";
import type { createLogger } from "../logger.js";

type Logger = ReturnType<typeof createLogger>;

// Scan one of the per-category subdirectories. Missing directory → []; that
// preserves the today's tools-only authoring shape — drop-in folders with no
// prompts/ or resources/ siblings see no behavior change.
export async function loadCategory<T extends { name: string }>(
  dir: string,
  subdir: "tools" | "prompts" | "resources",
  singular: "tool" | "prompt" | "resource",
  isShape: (v: unknown) => v is T,
  log: Logger,
): Promise<T[]> {
  const path = resolvePath(dir, subdir);
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  const items: T[] = [];
  const entries = readdirSync(path).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  for (const entry of entries) {
    const full = resolvePath(path, entry);
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const picked = pickShape(mod, isShape);
      // MCP-AUDIT #15: three cases, and the middle one used to match neither
      // branch — a duplicate NAME was dropped in complete silence, so a tool
      // simply did not exist and the author's only clue was its absence from the
      // manifest.
      if (!picked) {
        log.warn({ file: `${subdir}/${entry}` }, `no ${singular} default-export found — skipping`);
      } else if (items.some((existing) => existing.name === picked.name)) {
        log.warn(
          { file: `${subdir}/${entry}`, name: picked.name },
          `duplicate ${singular} name — keeping the first one found, skipping this file`,
        );
      } else {
        items.push(picked);
      }
    } catch (err) {
      log.error({ file: `${subdir}/${entry}`, err: err as Error }, `failed to import ${singular} file`);
    }
  }
  return items;
}

// Prefer the default export; fall back to the first named export that has the
// shape. Matches the authoring convention of one item per file.
function pickShape<T>(mod: Record<string, unknown>, isShape: (v: unknown) => v is T): T | undefined {
  if (isShape(mod.default)) return mod.default;
  for (const value of Object.values(mod)) {
    if (isShape(value)) return value;
  }
  return undefined;
}

export function isToolShape(value: unknown): value is Tool {
  return typeof value === "object"
    && value !== null
    && typeof (value as Tool).name === "string"
    && typeof (value as Tool).register === "function";
}

export function isPromptShape(value: unknown): value is Prompt {
  return typeof value === "object"
    && value !== null
    && typeof (value as Prompt).name === "string"
    && typeof (value as Prompt).register === "function";
}

export function isResourceShape(value: unknown): value is Resource {
  return typeof value === "object"
    && value !== null
    && typeof (value as Resource).name === "string"
    && typeof (value as Resource).register === "function";
}

// Load an optional per-folder capabilities.{ts,js} file. The module MUST
// default-export a plain object (Record<string, unknown>) that the runner
// hands to createMcpHttpServer as `capabilities`. Missing file / missing
// default export → undefined (no-op). Import errors log and swallow so a
// broken capabilities file doesn't crash an otherwise-healthy drop-in.
export async function loadCapabilities(
  dir: string,
  log: Logger,
): Promise<Record<string, unknown> | undefined> {
  const candidates = ["capabilities.ts", "capabilities.js"];
  for (const filename of candidates) {
    const full = resolvePath(dir, filename);
    if (!existsSync(full)) continue;
    try {
      const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown>;
      const picked = mod.default;
      if (picked && typeof picked === "object") {
        return picked as Record<string, unknown>;
      }
      log.warn({ file: filename }, `capabilities file has no default-exported object — ignoring`);
      return undefined;
    } catch (err) {
      log.error({ file: filename, err: err as Error }, `failed to import capabilities file`);
      return undefined;
    }
  }
  return undefined;
}

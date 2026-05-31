import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyVariantInFile, detectVariantInFile } from "@mcp-shim/shared";
import type { SourceConfig } from "../config.js";
import type { DocVariantName, SourceAdapter } from "./index.js";

export class FilesystemAdapter implements SourceAdapter {
  private readonly absolutePath: string;
  private readonly variants: SourceConfig["variants"];

  constructor(cfg: SourceConfig, configDir: string) {
    if (!cfg.path) throw new Error(`filesystem adapter requires 'path' (source: ${cfg.id})`);
    this.absolutePath = resolve(configDir, cfg.path);
    this.variants = cfg.variants;
  }

  // Reads from disk on every call. No caching — the freshness guarantee is
  // load-bearing (see packages/shared/src/variants.ts comment): the laptop
  // local-server can write the file directly and the next fetch() picks it up.
  // TODO(change-tracking): for long-running agent invocations, capture an etag/hash here
  // and surface it to the agent so it can detect mid-flight document edits.
  async fetch(): Promise<string> {
    return readFile(this.absolutePath, "utf8");
  }

  async currentVariant(): Promise<DocVariantName | undefined> {
    if (!this.variants) return undefined;
    return detectVariantInFile(this.absolutePath, this.variants);
  }

  async applyVariant(target?: DocVariantName): Promise<DocVariantName> {
    if (!this.variants) throw new Error("no variants configured for this source");
    return applyVariantInFile(this.absolutePath, this.variants, target);
  }
}

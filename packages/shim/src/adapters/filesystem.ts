import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

  // Reads from disk on every call. No caching — freshness guarantee per arch doc line 304.
  // TODO(change-tracking): for long-running agent invocations, capture an etag/hash here
  // and surface it to the agent so it can detect mid-flight document edits.
  async fetch(): Promise<string> {
    return readFile(this.absolutePath, "utf8");
  }

  async currentVariant(): Promise<DocVariantName | undefined> {
    if (!this.variants) return undefined;
    const text = await this.fetch();
    if (text.includes(this.variants.alternate.split("\n")[0])) return "alternate";
    if (text.includes(this.variants.original.split("\n")[0])) return "original";
    return undefined;
  }

  async applyVariant(target?: DocVariantName): Promise<DocVariantName> {
    if (!this.variants) throw new Error("no variants configured for this source");
    const text = await this.fetch();
    const current = await this.currentVariant();
    if (!current) {
      throw new Error(
        "neither variant detected in document — cannot determine where step 1 is"
      );
    }
    const next: DocVariantName =
      target ?? (current === "alternate" ? "original" : "alternate");

    if (current === next) {
      // Already in the requested state. No-op.
      return current;
    }

    // The variant currently in the file IS our marker — find it and replace it
    // with the other variant in place. This is robust regardless of which
    // variant is active.
    const currentText = current === "original" ? this.variants.original : this.variants.alternate;
    const idx = text.indexOf(currentText);
    if (idx === -1) {
      throw new Error("variant detected but exact text not found — file may have drifted");
    }
    const nextText = next === "original" ? this.variants.original : this.variants.alternate;
    const newText = text.slice(0, idx) + nextText + text.slice(idx + currentText.length);

    await writeFile(this.absolutePath, newText, "utf8");
    return next;
  }
}

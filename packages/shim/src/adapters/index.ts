import { FilesystemAdapter } from "./filesystem.js";
import type { SourceConfig } from "../config.js";

export type DocVariantName = "original" | "alternate";

export interface SourceAdapter {
  fetch(): Promise<string>;
  // Demo-only "Change" affordance: swap step 1 of the document between two
  // predefined variants from the YAML config. If `variant` is omitted, swap
  // to whichever variant is NOT currently active. Returns the new active
  // variant. Production adapters would not implement this — the shim is
  // read-only on customer documents.
  applyVariant?(variant?: DocVariantName): Promise<DocVariantName>;
  // Which variant is currently in the document, or undefined if not detectable.
  currentVariant?(): Promise<DocVariantName | undefined>;
}

// Adapter registry from arch doc line 69. Only filesystem is implemented for the POC;
// other types are placeholders so the shape of the registry is visible.
type AdapterCtor = (cfg: SourceConfig, configDir: string) => SourceAdapter;

export const ADAPTERS: Partial<Record<SourceConfig["type"], AdapterCtor>> = {
  filesystem: (cfg, configDir) => new FilesystemAdapter(cfg, configDir),
};

export function makeAdapter(cfg: SourceConfig, configDir: string): SourceAdapter {
  const ctor = ADAPTERS[cfg.type];
  if (!ctor) throw new Error(`Adapter not implemented for type: ${cfg.type}`);
  return ctor(cfg, configDir);
}

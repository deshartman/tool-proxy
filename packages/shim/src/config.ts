import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

export interface DocVariants {
  // The two variants of step 1 (or any unique block in the document). The
  // adapter detects which variant is currently in the file by exact-string
  // search, so each variant must be unique within the document.
  original: string;
  alternate: string;
}

export interface SourceConfig {
  id: string;
  type: "filesystem" | "confluence" | "sharepoint" | "http" | "rest" | "s3" | "notion";
  description: string;
  // Filesystem-only field for the POC. Other adapters would add their own.
  path?: string;
  // Demo-only: see shared/src/index.ts DocChangeRequestFrame.
  variants?: DocVariants;
}

export interface ShimConfig {
  shimId: string;
  configDir: string;
  sources: SourceConfig[];
}

export function loadConfig(configPath: string): ShimConfig {
  const absolute = resolve(configPath);
  const raw = readFileSync(absolute, "utf8");
  const parsed = parse(raw) as Omit<ShimConfig, "configDir">;
  return { ...parsed, configDir: dirname(absolute) };
}

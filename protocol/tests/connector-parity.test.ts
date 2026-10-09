import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONNECTOR_FRAME_SCHEMAS, CONTROLLER_FRAME_SCHEMAS } from "../src/schemas.js";

// Until the connector imports its frame types FROM this package, two copies
// exist: connector/src/tunnel/frames.ts (hand-written interfaces) and these
// schemas. This test fails the moment their frame-type sets diverge, which is
// the drift D7 exists to stop. It is the shim-side twin of the platform's
// frames-shim-contract test.

const here = dirname(fileURLToPath(import.meta.url));
const framesTs = readFileSync(join(here, "../../connector/src/tunnel/frames.ts"), "utf8");

function literalTypes(source: string): Set<string> {
  return new Set([...source.matchAll(/type: "([a-z-]+)"/g)].map((m) => m[1]));
}

function schemaTypes(schemas: readonly { shape: unknown }[]): Set<string> {
  return new Set(schemas.map((s) => ((s.shape as { type: { value: string } }).type.value)));
}

describe("protocol package ⇄ connector frames.ts", () => {
  it("covers exactly the frame types the connector declares", () => {
    const connector = literalTypes(framesTs);
    const pkg = new Set([...schemaTypes(CONNECTOR_FRAME_SCHEMAS), ...schemaTypes(CONTROLLER_FRAME_SCHEMAS)]);
    expect([...pkg].sort()).toEqual([...connector].sort());
  });
});

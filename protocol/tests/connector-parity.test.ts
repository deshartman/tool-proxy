import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// connector/src/tunnel/frames.ts is a hand-written copy covering the frame
// types of every major it speaks, so the union of all three tables must equal
// its type set. 3.x differs from 2.x only in register's field, so it adds no
// new frame type; it is still compared so a future 3.x frame cannot slip by.
import * as s1 from "../src/schemas-v1.js";
import * as s2 from "../src/schemas-v2.js";
import * as s3 from "../src/schemas-v3.js";

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
    const pkg = new Set(
      [s1, s2, s3].flatMap((s) => [...schemaTypes(s.CONNECTOR_FRAME_SCHEMAS), ...schemaTypes(s.CONTROLLER_FRAME_SCHEMAS)]),
    );
    expect([...pkg].sort()).toEqual([...connector].sort());
  });

  it("3.x introduces no frame type 2.x lacks (only register's field changes)", () => {
    const t = (s: typeof s2) => [...schemaTypes(s.CONNECTOR_FRAME_SCHEMAS), ...schemaTypes(s.CONTROLLER_FRAME_SCHEMAS)].sort();
    expect(t(s3 as unknown as typeof s2)).toEqual(t(s2));
  });
});

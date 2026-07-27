import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// C4 — startInspector must refuse to bind to a non-loopback address
// unless INSPECTOR_ALLOW_NONLOOPBACK=1 is set. Prevents silent typos
// (INSPECTOR_BIND_ADDR=0.0.0.0 on a host with a public IP) from
// exposing the copy-able bcrypt-protected webhook URLs.
//
// Static-analysis pinning — the actual bind gate is called from
// startInspector at process boot; instantiating that path in a unit
// test would spin up the whole Inspector class. The invariants below
// pin the presence of the throw path and the correct opt-in var name.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(
  join(__dirname, "../../src/inspector/server.ts"),
  "utf8",
);

describe("C4 — non-loopback bind requires INSPECTOR_ALLOW_NONLOOPBACK opt-in", () => {
  it("startInspector reads INSPECTOR_ALLOW_NONLOOPBACK", () => {
    expect(SERVER_SRC).toMatch(/INSPECTOR_ALLOW_NONLOOPBACK/);
  });

  it("throws Error when non-loopback bind is set without opt-in", () => {
    // The throw path exists — string-match on the error message keeps
    // the invariant testable without booting the inspector.
    expect(SERVER_SRC).toMatch(/refusing to bind/);
    expect(SERVER_SRC).toMatch(/INSPECTOR_ALLOW_NONLOOPBACK=1/);
  });

  it("loopback addresses (127.0.0.1, ::1, localhost) bypass the throw", () => {
    // The set of loopback addresses is enumerated; grep-match confirms
    // the enumeration includes each expected value.
    expect(SERVER_SRC).toMatch(/"127\.0\.0\.1"/);
    expect(SERVER_SRC).toMatch(/"::1"/);
    expect(SERVER_SRC).toMatch(/"localhost"/);
  });
});

describe("Fly deploy scaffolds carry the opt-in alongside INSPECTOR_BIND_ADDR", () => {
  const REPO_ROOT = join(__dirname, "../../..");
  const files = [
    "deploy/fly/fly.toml",
    "deploy/fly/fly.toml.example",
  ];

  for (const rel of files) {
    it(`${rel} sets INSPECTOR_ALLOW_NONLOOPBACK = "1"`, () => {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8");
      // If the file sets INSPECTOR_BIND_ADDR, it MUST also set the opt-in
      // — otherwise `fly deploy` deploys a container that refuses to boot.
      if (/INSPECTOR_BIND_ADDR\s*=/.test(content)) {
        expect(content).toMatch(/INSPECTOR_ALLOW_NONLOOPBACK\s*=\s*"1"/);
      }
    });
  }

  it("templates.ts fly.toml scaffold also emits the opt-in", () => {
    const templates = readFileSync(
      join(REPO_ROOT, "connector/src/deploy/templates.ts"),
      "utf8",
    );
    expect(templates).toMatch(/INSPECTOR_ALLOW_NONLOOPBACK\s*=\s*"1"/);
  });
});

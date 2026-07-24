import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../../src/config.js";

// loadConfig drives YAML ${VAR} interpolation, per-entry .env loading, and
// the per-entry env isolation invariant called out as the "highest-risk
// piece" in CLAUDE.md. Tests below exercise the env surface end-to-end —
// from process.env (via vi.stubEnv) through the YAML to the loaded config
// shape — because that's the integration point that breaks if any single
// link gets refactored.

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "connector-config-test-"));
  tmpRoots.push(dir);
  return dir;
}

function writeYaml(yaml: string): string {
  const root = makeTempRoot();
  const path = join(root, "connector.yaml");
  writeFileSync(path, yaml, "utf8");
  return path;
}

const minimalSuffix = `
mcp_servers:
  - name: dummy
    transport: http
    endpoint: http://127.0.0.1:9999/mcp
`;

describe("loadConfig — \${VAR} interpolation", () => {
  it("substitutes a defined env var into the controller_url", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel.controller_url).toBe("https://controller.example.com");
    expect(config.tunnel.auth_token).toBe("ts_test");
  });

  it("falls back to the \${VAR:-default} default when the env var is undefined", () => {
    // Deliberately do NOT stubEnv("CONTROLLER_URL_FALLBACK_TEST", ...)
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL_FALLBACK_TEST:-https://default.example.com}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel.controller_url).toBe("https://default.example.com");
  });

  it("a defined env var beats its inline default", () => {
    vi.stubEnv("CONTROLLER_URL", "https://from-env.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL:-https://from-default.example.com}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel.controller_url).toBe("https://from-env.example.com");
  });

  it("full-line yaml comments are inert — a bare \${UNSET_VAR} inside a comment does NOT throw", () => {
    // This is the root cause of the Step 8 retrospective. `interpolateEnv` is
    // a pre-parse text pass; if it matched inside comments (as it originally
    // did), any doc comment mentioning `${CONTROLLER_URL}` would hard-fail
    // boot when a customer hadn't set that var — even though yaml itself
    // would happily ignore the comment. Pin the inertness of yaml comments
    // here so a future refactor can't silently regress the behavior.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");
    // Deliberately do NOT stub UNSET_VAR_MENTIONED_IN_COMMENT.

    const yamlPath = writeYaml(`
# This comment mentions \${UNSET_VAR_MENTIONED_IN_COMMENT} for documentation purposes.
# Also indented:
  # \${ANOTHER_UNSET_VAR}
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    // MUST NOT throw. The comments carry ${...} references that would
    // otherwise trip the interpolator; the fix skips comment lines entirely.
    expect(() => loadConfig(yamlPath)).not.toThrow();

    const config = loadConfig(yamlPath);
    // Real interpolation on non-comment lines still works.
    expect(config.tunnel?.controller_url).toBe("https://controller.example.com");
  });

  it("inline comments after values ARE still interpolated (only full-line comments skip)", () => {
    // Intentional non-goal: the pre-parse pass has no yaml-quote-aware
    // parser, so an inline comment scanner would need string-quote tracking
    // to be safe. Instead we keep the inline case strict — a customer who
    // puts `${VAR}` in an inline comment position and hasn't set VAR will
    // still hit the throw, and that's a fine failure mode (rare + easy
    // fix). Pin this so a future "fully skip comments" refactor understands
    // the deliberate scope.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");
    // UNSET_INLINE_VAR intentionally unset.

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}  # inline mention: \${UNSET_INLINE_VAR}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    expect(() => loadConfig(yamlPath)).toThrow(/UNSET_INLINE_VAR/);
  });

  it("throws naming the missing env var AND the YAML line number for an admin to fix the right line", () => {
    // No stubEnv — UNDEFINED_VAR is genuinely missing.
    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL:-https://default.example.com}
  name: test-customer
  auth_token: \${UNDEFINED_VAR_FOR_TEST}
${minimalSuffix}
`);

    // Error must (a) name the var so the admin knows what to set, and (b)
    // include a file:line reference so they don't grep blindly. Pin both.
    expect(() => loadConfig(yamlPath)).toThrow(/UNDEFINED_VAR_FOR_TEST/);
    expect(() => loadConfig(yamlPath)).toThrow(/connector\.yaml:\d+/);
  });

  it("an empty-string env var is treated as 'set' (substitutes empty), NOT 'undefined' (no default fallback)", () => {
    // This is a subtle corner — an admin who wrote `CONTROLLER_URL=` in
    // .env meant "leave it blank", and the yaml interpolator should honor
    // that. Pin the substitution semantics: empty is passed through, not
    // replaced with the ${VAR:-default} fallback.
    vi.stubEnv("CONTROLLER_URL", "");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL:-https://default.example.com}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    // CONTROLLER_URL="" → interpolator emits "" (NOT the fallback default).
    // Schema-level validation accepts empty controller_url because the
    // env-vs-db-mode enforcement lives downstream in boot: bootFromEnv
    // throws a clear error if empty, bootFromDb ignores + WARNs. This pins
    // the "empty != undefined but empty is not an interpolator error"
    // contract.
    expect(config.tunnel?.controller_url).toBe("");
  });
});

describe("loadConfig — Step 8 regression: db-mode migration end state", () => {
  // Regression coverage for ENV-TO-DB Step 8's ordering miss. The plan intent
  // was "tunnel: block is optional-with-WARN under db mode" but the initial
  // Step 8 landed only the downstream WARN — leaving interpolateEnv() to
  // hard-throw on ${CONTROLLER_URL} before the WARN could ever fire. Under
  // the target migration end state (operator strips CONTROLLER_URL /
  // CONNECTOR_NAME from .env, keeps the legacy tunnel: block in yaml),
  // db-mode boot must survive. These tests pin the fixed contract.

  it("legacy tunnel: block with ${VAR:-} defaults + unset env vars parses cleanly (empty strings)", () => {
    // Target state: operator followed the migration doc, removed CONTROLLER_URL
    // and CONNECTOR_NAME from .env, but still has the legacy tunnel: block in
    // ./connector.yaml. Interpolation must NOT throw — the yaml uses ${VAR:-}
    // defaults so empty is the graceful fallback.
    // Deliberately do NOT stubEnv either var — they are genuinely unset.
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL:-}
  name: \${CONNECTOR_NAME:-}
  auth_token: \${TUNNEL_AUTH_TOKEN:-}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    // Block present in parsed config, all interpolated fields empty. Empty
    // controller_url is a schema-level pass — enforcement moved to boot-mode
    // guards (bootFromEnv throws; bootFromDb WARNs + ignores).
    expect(config.tunnel).toBeDefined();
    expect(config.tunnel?.controller_url).toBe("");
    expect(config.tunnel?.name).toBe("");
    // auth_token transform maps "" → undefined (existing contract, pinned above).
    expect(config.tunnel?.auth_token).toBeUndefined();
  });

  it("yaml with tunnel: block entirely removed parses cleanly (config.tunnel is undefined)", () => {
    // Further target state: operator has completed migration and removed the
    // legacy tunnel: block entirely from ./connector.yaml. Schema now allows
    // absence (Step 14 removal path, arriving early). bootFromDb sees
    // config.tunnel === undefined and just skips the WARN.
    const yamlPath = writeYaml(`
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel).toBeUndefined();
  });

  it("populated tunnel: block still parses with real values (env-mode happy path unchanged)", () => {
    // Backwards-compat regression: env-mode operators whose CONTROLLER_URL /
    // CONNECTOR_NAME are populated (via requireEnv gate) must still see the
    // interpolated real values reach config.tunnel — the schema change must
    // not disturb the primary env-mode boot path.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("CONNECTOR_NAME", "my-connector");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_real_token");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL:-}
  name: \${CONNECTOR_NAME:-}
  auth_token: \${TUNNEL_AUTH_TOKEN:-}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel?.controller_url).toBe("https://controller.example.com");
    expect(config.tunnel?.name).toBe("my-connector");
    expect(config.tunnel?.auth_token).toBe("ts_real_token");
  });

  // Note: the prior "SHIPPED connector.yaml.example loads cleanly with no
  // tunnel env vars set" pin retired with the customer-repo carve-out —
  // there is no connector.yaml.example anymore. The remaining inline-yaml
  // tests above still cover the ${VAR:-} interpolator contract.
});

describe("loadConfig — per-entry .env isolation (the 'highest-risk piece' per CLAUDE.md)", () => {
  it("loads <dir>/.env into spec.env without mutating process.env", () => {
    // Two MCP entries each with their own dir + .env declaring the SAME
    // var name with DIFFERENT values. Per CLAUDE.md, child A's API_TOKEN
    // does not reach child B even when both .env files declare the same
    // key. The loader must populate per-spec env maps and leave
    // process.env untouched.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");
    // Sanity: API_TOKEN is genuinely absent on process.env at the start.
    vi.stubEnv("API_TOKEN", "");

    const root = makeTempRoot();
    const aDir = join(root, "mcp-a");
    const bDir = join(root, "mcp-b");
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(aDir, ".env"), "API_TOKEN=token-for-a\n", "utf8");
    writeFileSync(join(bDir, ".env"), "API_TOKEN=token-for-b\n", "utf8");

    const yamlPath = join(root, "connector.yaml");
    writeFileSync(
      yamlPath,
      `
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: mcp-a
    transport: http
    dir: ./mcp-a
  - name: mcp-b
    transport: http
    dir: ./mcp-b
`,
      "utf8",
    );

    const config = loadConfig(yamlPath);

    const a = config.mcp_servers.find((s) => s.name === "mcp-a");
    const b = config.mcp_servers.find((s) => s.name === "mcp-b");
    expect(a?.env).toEqual({ API_TOKEN: "token-for-a" });
    expect(b?.env).toEqual({ API_TOKEN: "token-for-b" });

    // The load MUST NOT have leaked either token into process.env. If it
    // did, both MCP children would see whichever .env happened to load
    // last — exactly the cross-contamination CLAUDE.md flags as the
    // highest-risk failure mode.
    expect(process.env.API_TOKEN).not.toBe("token-for-a");
    expect(process.env.API_TOKEN).not.toBe("token-for-b");
  });

  it("inline yaml `env:` overrides the same key from <dir>/.env", () => {
    // Documented precedence rule in config.ts: yaml takes precedence over
    // <dir>/.env. An admin debugging a bad .env value should be able to
    // pin a known-good value inline in the yaml without editing the .env.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const root = makeTempRoot();
    const dir = join(root, "mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), "API_TOKEN=from-dot-env\n", "utf8");

    const yamlPath = join(root, "connector.yaml");
    writeFileSync(
      yamlPath,
      `
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: mcp
    transport: http
    dir: ./mcp
    env:
      API_TOKEN: from-yaml
`,
      "utf8",
    );

    const config = loadConfig(yamlPath);

    const mcp = config.mcp_servers[0];
    expect(mcp.env?.API_TOKEN).toBe("from-yaml");
  });

  it("missing <dir>/.env is silently OK — the spec just keeps whatever inline env it has", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const root = makeTempRoot();
    const dir = join(root, "mcp");
    mkdirSync(dir, { recursive: true });
    // Deliberately do NOT create dir/.env

    const yamlPath = join(root, "connector.yaml");
    writeFileSync(
      yamlPath,
      `
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: mcp
    transport: http
    dir: ./mcp
    env:
      INLINE_ONLY: kept
`,
      "utf8",
    );

    const config = loadConfig(yamlPath);

    expect(config.mcp_servers[0].env).toEqual({ INLINE_ONLY: "kept" });
  });
});

describe("loadConfig — auth_token zod transform", () => {
  it("an empty-string TUNNEL_AUTH_TOKEN substitution maps to undefined (zod transform)", () => {
    // The yaml schema's auth_token transform converts "" → undefined so
    // resolveAuth's truthy check downstream behaves consistently. Pin the
    // boundary: an admin's blank-line .env value should not result in a
    // zero-length token reaching the WS handshake.
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel.auth_token).toBeUndefined();
  });

  it("a populated TUNNEL_AUTH_TOKEN substitution flows through verbatim", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_real_token_84_chars_long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
${minimalSuffix}
`);

    const config = loadConfig(yamlPath);

    expect(config.tunnel.auth_token).toBe(
      "ts_real_token_84_chars_long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
  });
});

describe("loadConfig — bundled MCP dev override (BUNDLE_DEV_OVERRIDE_*)", () => {
  it("redirects launch to the override path when BUNDLE_DEV_OVERRIDE_<NAME> is set", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");
    vi.stubEnv("BUNDLE_DEV_OVERRIDE_ENTERPRISE_KNOWLEDGE", "/tmp/dev-launch.sh");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: ek
    bundled: enterprise-knowledge
`);

    const config = loadConfig(yamlPath);

    const ek = config.mcp_servers[0];
    expect(ek.transport).toBe("stdio");
    if (ek.transport === "stdio") {
      // Override wins over the BUNDLED_MCPS registry entry.
      expect(ek.command).toEqual(["/tmp/dev-launch.sh"]);
      // bundled: name preserved for reconnect-equality + traceability.
      expect(ek.bundled).toBe("enterprise-knowledge");
    }
  });

  it("falls back to BUNDLED_MCPS registry when no override env var is set", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");
    // Explicit unset so a stale override from a previous test can't leak in
    // (vi.unstubAllEnvs in afterEach handles this, but be defensive).
    vi.stubEnv("BUNDLE_DEV_OVERRIDE_ENTERPRISE_KNOWLEDGE", "");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: ek
    bundled: enterprise-knowledge
`);

    const config = loadConfig(yamlPath);

    const ek = config.mcp_servers[0];
    if (ek.transport === "stdio") {
      // The registry entry's launch path; concrete value documents the
      // image-layout assumption so a future relayout breaks loudly here.
      expect(ek.command).toEqual([
        "/opt/bundled-mcps/enterprise-knowledge/.venv/bin/customer-ek-mcp",
      ]);
    }
  });

  it("throws an admin-actionable error naming the dev-override env var when the bundle is unknown", () => {
    vi.stubEnv("CONTROLLER_URL", "https://controller.example.com");
    vi.stubEnv("TUNNEL_AUTH_TOKEN", "ts_test");

    const yamlPath = writeYaml(`
tunnel:
  controller_url: \${CONTROLLER_URL}
  name: test-customer
  auth_token: \${TUNNEL_AUTH_TOKEN}
mcp_servers:
  - name: mystery
    bundled: not-a-real-bundle
`);

    expect(() => loadConfig(yamlPath)).toThrow(/unknown bundle "not-a-real-bundle"/);
    // Error must point at the dev-override env var so a developer running
    // a working tree knows how to wire it up without reading source.
    expect(() => loadConfig(yamlPath)).toThrow(/BUNDLE_DEV_OVERRIDE_NOT_A_REAL_BUNDLE/);
  });
});

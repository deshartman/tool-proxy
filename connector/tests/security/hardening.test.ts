import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Consolidated pinning tests for the security-hardening PR.
//
// Each `describe` block below anchors one of the audit findings from
// architectural-plans/SECURITY-HARDENING.md. A future refactor that
// silently regresses any of these invariants fails a CI test with a
// pointer to the finding — rather than shipping a re-opened
// vulnerability.
//
// The tests below are all static-analysis on the checked-in files. They
// intentionally do NOT boot a container or run a real request — those
// are covered by the per-step tests (entrypoint.test.ts, csrf-guard.
// test.ts, webhook-stream-auth.test.ts, security-headers.test.ts, etc.).
// This file is the trip-wire.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");

const DOCKERFILE     = readFileSync(join(ROOT, "connector/Dockerfile"), "utf8");
const ENTRYPOINT     = readFileSync(join(ROOT, "connector/entrypoint.sh"), "utf8");
const DOCKERIGNORE   = readFileSync(join(ROOT, ".dockerignore"), "utf8");
const COMPOSE_PROD   = readFileSync(join(ROOT, "deploy/compose/docker-compose.prod.yml"), "utf8");
const HELM_VALUES    = readFileSync(join(ROOT, "deploy/helm/mcp-connector/values.yaml"), "utf8");
const HELM_DEPLOY    = readFileSync(join(ROOT, "deploy/helm/mcp-connector/templates/deployment.yaml"), "utf8");
const INSPECTOR_SRC  = readFileSync(join(ROOT, "connector/src/inspector/server.ts"), "utf8");
const SUPERVISOR_SRC = readFileSync(join(ROOT, "connector/src/mcp-supervisor.ts"), "utf8");
const SDK_WEBHOOK    = readFileSync(join(ROOT, "connector/src/sdk/webhook.ts"), "utf8");
const COMPOSE_TMPL   = readFileSync(join(ROOT, "connector/src/deploy/templates.ts"), "utf8");

// ── F1 + F2 — non-root container UID + unset CONNECTOR_KEY_B64 ────────────
describe("F1 + F2 — Dockerfile creates mcp user; entrypoint drops privileges + unsets key env", () => {
  it("Dockerfile creates the mcp user + chowns critical paths", () => {
    expect(DOCKERFILE).toMatch(/adduser\s+-S\s+-G\s+mcp/);
    expect(DOCKERFILE).toMatch(/chown\s+-R\s+mcp:mcp/);
  });

  it("entrypoint unsets CONNECTOR_KEY_B64 before exec (no leak to /proc/1/environ)", () => {
    expect(ENTRYPOINT).toMatch(/unset\s+CONNECTOR_KEY_B64/);
    // Ensure the unset happens BEFORE exec — a naive s/exec.*unset/… would
    // regress this. Assert order via string index.
    const unsetIdx = ENTRYPOINT.indexOf("unset CONNECTOR_KEY_B64");
    const execIdx = ENTRYPOINT.lastIndexOf("exec ");
    expect(unsetIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(unsetIdx);
  });

  it("entrypoint drops privileges via su-exec — NO 'else exec node' fallback branch", () => {
    // If su-exec / id -u mcp fail, the connector must NOT silently fall
    // back to root. The strict-fail behavior is the whole point of Step 2.
    expect(ENTRYPOINT).toMatch(/exec\s+su-exec\s+mcp:mcp\s+node\s+dist\/index\.js/);
    // Absence of a fallback: no "else exec node dist/index.js" pattern.
    expect(ENTRYPOINT).not.toMatch(/else[^}]*exec\s+node\s+dist\/index\.js/);
  });

  it("entrypoint chown is strict — no `|| true` softening on the master-key chown", () => {
    expect(ENTRYPOINT).toMatch(/chown\s+mcp:mcp\s+["']?\$key_file/);
    expect(ENTRYPOINT).not.toMatch(/chown\s+mcp:mcp[^\n]*\|\|\s*true/);
  });
});

// ── C2 — base images pinned to sha256 digest ─────────────────────────────
describe("C2 — Dockerfile pins base images to @sha256 digests", () => {
  it("every FROM line either references an internal stage or a @sha256 digest", () => {
    const froms = DOCKERFILE.match(/^FROM\s+.+$/gm) ?? [];
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) {
      // Internal stage reference: `FROM node-build AS ...` — OK, no digest.
      if (/FROM\s+[a-z-]+\s+AS/.test(line) && !/\//.test(line)) continue;
      expect(line, `unpinned base: ${line}`).toMatch(/@sha256:[a-f0-9]{64}/);
    }
  });
});

// ── C7 — .dockerignore excludes the audit's specified paths ──────────────
describe("C7 — .dockerignore excludes secrets, state files, key material, session data", () => {
  const required = [
    ".env.old",
    ".claude",
    ".connector-state.json",
    "*.pem",
    "*.key",
    "id_rsa*",
    "architectural-plans",
  ];
  for (const pattern of required) {
    it(`excludes ${pattern}`, () => {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // No `\b` — patterns like `id_rsa*` end in a non-word char.
      expect(DOCKERIGNORE).toMatch(new RegExp(`^\\s*${escaped}`, "m"));
    });
  }
});

// ── docker-compose.prod.yml invariants ───────────────────────────────────
describe("docker-compose.prod.yml — inspector loopback + no inline credentials", () => {
  it("binds inspector to 127.0.0.1 only", () => {
    expect(COMPOSE_PROD).toMatch(/["']127\.0\.0\.1:9090:9090["']/);
    expect(COMPOSE_PROD).not.toMatch(/^\s*-\s*["']?9090:9090\b/m);
    expect(COMPOSE_PROD).not.toMatch(/["']0\.0\.0\.0:9090:9090["']/);
  });

  // C8 originally protected a Postgres password from landing in this YAML as
  // a string, and from being shell-eval'd out of a file with $(cat ...).
  // DB-TO-FILE deleted the DSN, so there is no password to protect. The
  // hazard class it guarded — a credential that reaches the container as a
  // VALUE rather than a mount — still applies to the one secret that remains.
  it("carries no credential as a value; the master key arrives as a mount", () => {
    // COMPOSE_TMPL is the whole templates.ts, which legitimately still names
    // Postgres for the fly-mock target (the mock CRM backend IS
    // Postgres-backed). Slice out just the compose template's body.
    const composeTemplate = COMPOSE_TMPL.slice(
      COMPOSE_TMPL.indexOf("const COMPOSE_YML = `"),
      COMPOSE_TMPL.indexOf("const COMPOSE_ENV = `"),
    );
    expect(composeTemplate, "COMPOSE_YML marker moved — fix the slice").toContain("services:");

    for (const [label, text] of [["prod", COMPOSE_PROD], ["scaffold", composeTemplate]] as const) {
      // No command substitution anywhere — that was the C8 failure shape.
      expect(text, `${label}: shell substitution in compose`).not.toMatch(/\$\(/);
      // The key is referenced only as a read-only file mount, never assigned.
      expect(text, `${label}: key path assigned as a value`)
        .not.toMatch(/CONNECTOR_KEY_B64\s*[:=]/);
      expect(text, `${label}: no key mount`)
        .toMatch(/connector\.key:\/etc\/mcp-connector\/connector\.key:ro/);
    }
    // And the retired DSN plumbing is gone from both.
    expect(COMPOSE_PROD).not.toMatch(/POSTGRES/);
    expect(composeTemplate).not.toMatch(/POSTGRES/);
  });
});

// ── C2 (helm) — image.tag not `latest`; templates require it ─────────────
describe("C2 (helm) — image.tag is not defaulted to latest; deployment requires it", () => {
  it("values.yaml image.tag is empty or explicit (never `latest`)", () => {
    expect(HELM_VALUES).not.toMatch(/^\s*tag:\s*latest\s*$/m);
  });

  it("deployment.yaml wraps image.tag in the required helper (fail-loud on empty)", () => {
    expect(HELM_DEPLOY).toMatch(/required\s+"[^"]*"\s+\.Values\.image\.tag/);
  });
});

// ── F3 — CSRF guard exists on inspector state-changing routes ────────────
describe("F3 — CSRF guard on inspector state-changing routes", () => {
  it("exports guardCsrf helper", () => {
    expect(INSPECTOR_SRC).toMatch(/export\s+function\s+guardCsrf/);
  });
});

// ── F4 — .connector-state.json (env mode) ─────────────────────────────────
// F4 was retired with env-mode removal. The registration token lives in the
// sealed config store, which DB-TO-FILE moved from a Postgres row back to a
// FILE — but not the same file and not in the same shape: it is
// /var/lib/mcp-connector/state/config.json, written 0600, with every
// credential inside it sealed by libsodium under the master key. The thing F4
// protected against was a PLAINTEXT token on disk, and that remains absent.
// .dockerignore still excludes any leftover .connector-state.json on an
// upgrading host as belt-and-braces (see C7 above).

// ── F7 — per-MCP webhook token ───────────────────────────────────────────
describe("F7 — webhook stream + revoke enforce per-MCP identity", () => {
  it("supervisor exposes resolveMcpByWebhookToken using timingSafeEqual", () => {
    expect(SUPERVISOR_SRC).toMatch(/resolveMcpByWebhookToken/);
    expect(SUPERVISOR_SRC).toMatch(/timingSafeEqual/);
  });

  it("supervisor mints per-MCP webhookToken (randomBytes base64url)", () => {
    expect(SUPERVISOR_SRC).toMatch(/webhookToken:\s*randomBytes\(32\)\.toString\("base64url"\)/);
  });

  it("supervisor injects MCP_WEBHOOK_TOKEN into merged env", () => {
    expect(SUPERVISOR_SRC).toMatch(/MCP_WEBHOOK_TOKEN\s*=\s*entry\.webhookToken/);
  });

  it("SDK sends Authorization: Bearer on webhook subscribe + revoke", () => {
    expect(SDK_WEBHOOK).toMatch(/MCP_WEBHOOK_TOKEN/);
    expect(SDK_WEBHOOK).toMatch(/authorization:\s*`Bearer/);
  });

  it("inspector authorizeWebhookMcp gates stream + revoke", () => {
    expect(INSPECTOR_SRC).toMatch(/function\s+authorizeWebhookMcp/);
    // handleStream and handleRevoke both call it
    const streamMatch = INSPECTOR_SRC.match(/function\s+handleStream[\s\S]*?authorizeWebhookMcp/);
    const revokeMatch = INSPECTOR_SRC.match(/function\s+handleRevoke[\s\S]*?authorizeWebhookMcp/);
    expect(streamMatch, "handleStream must call authorizeWebhookMcp").toBeTruthy();
    expect(revokeMatch, "handleRevoke must call authorizeWebhookMcp").toBeTruthy();
  });
});

// ── C1 + C11 — CSP + nosniff on static assets ────────────────────────────
describe("C1 + C11 — inspector static-asset security headers", () => {
  it("inspector emits Content-Security-Policy with strict default-src", () => {
    expect(INSPECTOR_SRC).toMatch(/content-security-policy/);
    expect(INSPECTOR_SRC).toMatch(/default-src\s+'self'/);
    expect(INSPECTOR_SRC).toMatch(/frame-ancestors\s+'none'/);
    // Never introduce unsafe-eval — dropping it should require an explicit
    // security review, not a silent commit.
    expect(INSPECTOR_SRC).not.toMatch(/'unsafe-eval'/);
  });

  it("inspector emits X-Content-Type-Options: nosniff + X-Frame-Options: DENY", () => {
    expect(INSPECTOR_SRC).toMatch(/x-content-type-options[^\n]*nosniff/);
    expect(INSPECTOR_SRC).toMatch(/x-frame-options[^\n]*DENY/);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scaffoldTo } from "../../src/deploy/scaffold.js";
import { render, type ScaffoldVars } from "../../src/deploy/templates.js";

// Two layers of test:
//   1. render() — pure. Assert per-target that the substituted string
//      contains the values we care about. Fast, catches template drift.
//   2. scaffoldTo() — writes to a tmpdir. Asserts file names, force flag,
//      overwrite guard.

const VARS: ScaffoldVars = {
  name: "prod-us-east-1",
  controllerUrl: "https://controller.example.com",
  image: "ghcr.io/twilio/mcp-connector:0.2.0",
  credsSource: "db",
  auth: "static",
};

describe("render — variable substitution", () => {
  it("substitutes NAME + CONTROLLER_URL + IMAGE into fargate task def", () => {
    const { files } = render("fargate", VARS);
    const task = files.find((f) => f.path === "task-definition.json");
    expect(task).toBeDefined();
    expect(task!.content).toContain("mcp-connector-prod-us-east-1");
    expect(task!.content).toContain("ghcr.io/twilio/mcp-connector:0.2.0");
    expect(task!.content).toContain('"value": "prod-us-east-1"');
    expect(task!.content).toContain('"value": "https://controller.example.com"');
  });

  it("emits secrets-hint.sh with the connector name interpolated for aws cli", () => {
    const { files } = render("fargate", VARS);
    const hint = files.find((f) => f.path === "secrets-hint.sh");
    expect(hint!.content).toContain("mcp-connector/prod-us-east-1/tunnel-auth-token");
  });

  it("substitutes across all five gke manifests", () => {
    const { files } = render("gke", VARS);
    expect(files.map((f) => f.path)).toEqual([
      "namespace.yaml",
      "secret.yaml",
      "configmap.yaml",
      "deployment.yaml",
      "pvc.yaml",
    ]);
    // Every manifest carries the connector name in its namespace field.
    for (const file of files) {
      expect(file.content, `${file.path} should reference the namespace`).toContain("mcp-connector-prod-us-east-1");
    }
    const deployment = files.find((f) => f.path === "deployment.yaml")!;
    expect(deployment.content).toContain("ghcr.io/twilio/mcp-connector:0.2.0");
  });

  it("preserves ${VAR} yaml interpolation in the configmap (do not substitute at scaffold time)", () => {
    const { files } = render("gke", VARS);
    const cm = files.find((f) => f.path === "configmap.yaml")!;
    // These are runtime yaml interpolations — the customer's connector
    // resolves them at boot. Scaffold must NOT touch them.
    expect(cm.content).toContain("${CONTROLLER_URL:-}");
    expect(cm.content).toContain("${CONNECTOR_NAME:-}");
    expect(cm.content).toContain("${TUNNEL_AUTH_TOKEN:-}");
  });

  it("emits a single-file aca bicep template", () => {
    const { files } = render("aca", VARS);
    expect(files.map((f) => f.path)).toEqual(["containerapp.bicep"]);
    const bicep = files[0].content;
    // Bicep resolves `${connectorName}` at deployment time; scaffold's
    // {{NAME}} substitution must not touch that syntax.
    expect(bicep).toContain("mcp-connector-${connectorName}");
    expect(bicep).toContain("'prod-us-east-1'");
    expect(bicep).toContain("'ghcr.io/twilio/mcp-connector:0.2.0'");
    expect(bicep).toContain("minReplicas: 1"); // single connector — no HPA
  });

  it("emits compose files with 127.0.0.1 inspector binding", () => {
    const { files } = render("compose", VARS);
    expect(files.map((f) => f.path)).toEqual(["docker-compose.yml", ".env.example"]);
    const compose = files.find((f) => f.path === "docker-compose.yml")!;
    // Load-bearing: exposing the inspector on 0.0.0.0 would leak
    // webhook URLs. The scaffold MUST pin the bind to loopback.
    expect(compose.content).toContain(`"127.0.0.1:9090:9090"`);
    expect(compose.content).not.toContain(`"0.0.0.0:9090`);
    expect(compose.content).toContain("mcp-connector"); // image is the connector
  });

  it("switches CREDS_SOURCE in the compose file when told", () => {
    const { files } = render("compose", { ...VARS, credsSource: "env" });
    const compose = files.find((f) => f.path === "docker-compose.yml")!;
    expect(compose.content).toContain("CONNECTOR_CREDS_SOURCE: env");
  });

  it("emits a readme appendix telling the customer what to do next", () => {
    for (const target of ["fargate", "gke", "aca", "compose", "fly", "fly-mock"] as const) {
      const { readmeAppendix } = render(target, VARS);
      expect(readmeAppendix.length, `${target} appendix`).toBeGreaterThan(50);
    }
  });

  it("emits fly.toml with substituted app name + image and NO public service", () => {
    const { files } = render("fly", VARS);
    expect(files.map((f) => f.path)).toEqual(["fly.toml", "secrets-hint.sh"]);

    const toml = files.find((f) => f.path === "fly.toml")!;
    expect(toml.content).toContain(`app = "mcp-connector-prod-us-east-1"`);
    expect(toml.content).toContain(`image = "ghcr.io/twilio/mcp-connector:0.2.0"`);
    expect(toml.content).toContain(`CONNECTOR_CREDS_SOURCE = "db"`);

    // Load-bearing invariants — outbound-only, no scale-to-zero, no public IP.
    // If any of these regress as ACTIVE toml (not a comment mention),
    // the deploy silently starts leaking the bcrypt-protected webhook URLs
    // or dying at first idle. Match line-start to allow the file to still
    // *mention* the invariants in its own reminder comments.
    expect(toml.content).not.toMatch(/^\[\[services\]\]/m);
    expect(toml.content).not.toMatch(/^\[http_service\]/m);
    expect(toml.content).not.toMatch(/^\s*auto_stop_machines\s*=/m);

    // Volume mount for state — belt-and-braces per D3.
    expect(toml.content).toContain(`source = "state"`);
    expect(toml.content).toContain(`destination = "/var/lib/mcp-connector"`);
  });

  it("emits fly-mock fly.toml + Dockerfile with private-only invariants", () => {
    const { files } = render("fly-mock", VARS);
    expect(files.map((f) => f.path)).toEqual(["fly.toml", "Dockerfile"]);

    const toml = files.find((f) => f.path === "fly.toml")!;
    expect(toml.content).toContain(`app = "mock-customers-prod-us-east-1"`);
    expect(toml.content).toContain(`dockerfile = "Dockerfile"`);
    expect(toml.content).toContain(`PORT = "7400"`);

    // Load-bearing invariants: the mock is private by contract. If any of
    // these regress as ACTIVE toml, the mock stops modelling an enterprise
    // firewall'd backend and becomes reachable from the public internet.
    expect(toml.content).not.toMatch(/^\[\[services\]\]/m);
    expect(toml.content).not.toMatch(/^\[http_service\]/m);

    const dockerfile = files.find((f) => f.path === "Dockerfile")!;
    expect(dockerfile.content).toContain("FROM node:22-alpine");
    expect(dockerfile.content).toContain("EXPOSE 7400");
    expect(dockerfile.content).toContain("tsx");
  });

  it("emits secrets-hint.sh with Postgres attach + master key + volume steps", () => {
    const { files } = render("fly", VARS);
    const hint = files.find((f) => f.path === "secrets-hint.sh")!;

    // Postgres must attach as POSTGRES_URL, not the default DATABASE_URL —
    // the connector's env reader looks for POSTGRES_URL.
    expect(hint.content).toContain("--variable-name POSTGRES_URL");
    expect(hint.content).toContain("--database-name mcp_connector");
    expect(hint.content).toContain("mcp-connector-prod-us-east-1-db");

    // Master key delivery is the entrypoint-decoded env var, not a file.
    expect(hint.content).toContain("CONNECTOR_KEY_B64");
    expect(hint.content).toContain("head -c 32 /dev/urandom | base64");

    // Inspector reach is `fly proxy`, not any public exposure.
    expect(hint.content).toContain("fly proxy 9090:9090 -a mcp-connector-prod-us-east-1");
    expect(hint.content).toContain("https://controller.example.com");
  });
});

describe("scaffoldTo — file writes", () => {
  it("writes all target files to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-"));
    try {
      const result = await scaffoldTo("compose", VARS, outDir);
      expect(result.written).toHaveLength(2);
      // Assert the files exist on disk and carry the substituted values.
      const compose = readFileSync(join(outDir, "docker-compose.yml"), "utf8");
      expect(compose).toContain("prod-us-east-1");
      const env = readFileSync(join(outDir, ".env.example"), "utf8");
      expect(env).toContain("TUNNEL_AUTH_TOKEN=");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing files without --force", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-"));
    try {
      writeFileSync(join(outDir, "docker-compose.yml"), "# user's own file\n");

      await expect(scaffoldTo("compose", VARS, outDir)).rejects.toThrow(/refusing to overwrite/);
      // User's file must survive the failed run.
      expect(readFileSync(join(outDir, "docker-compose.yml"), "utf8")).toBe("# user's own file\n");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("overwrites with force=true", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-"));
    try {
      writeFileSync(join(outDir, "docker-compose.yml"), "# stale\n");

      const result = await scaffoldTo("compose", VARS, outDir, { force: true });
      expect(result.written).toHaveLength(2);
      expect(readFileSync(join(outDir, "docker-compose.yml"), "utf8")).toContain("prod-us-east-1");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("creates the outDir if it doesn't exist", async () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    try {
      const nested = join(parent, "deep", "nested", "path");
      const result = await scaffoldTo("gke", VARS, nested);
      expect(result.written).toHaveLength(5);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("writes fly.toml + secrets-hint.sh to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-fly-"));
    try {
      const result = await scaffoldTo("fly", VARS, outDir);
      expect(result.written).toHaveLength(2);
      const toml = readFileSync(join(outDir, "fly.toml"), "utf8");
      expect(toml).toContain("prod-us-east-1");
      const hint = readFileSync(join(outDir, "secrets-hint.sh"), "utf8");
      expect(hint).toContain("CONNECTOR_KEY_B64");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("writes fly-mock fly.toml + Dockerfile to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-fly-mock-"));
    try {
      const result = await scaffoldTo("fly-mock", VARS, outDir);
      expect(result.written).toHaveLength(2);
      const toml = readFileSync(join(outDir, "fly.toml"), "utf8");
      expect(toml).toContain("mock-customers-prod-us-east-1");
      const df = readFileSync(join(outDir, "Dockerfile"), "utf8");
      expect(df).toContain("FROM node:22-alpine");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

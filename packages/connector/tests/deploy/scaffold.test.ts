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
  // Matches the fly default (`mcp-connector-<name>`). Fly-mock tests
  // override with `{ ...VARS, appName: "mock-customers-prod-us-east-1" }`.
  // Non-Fly targets ignore this field — their templates use {{NAME}}.
  appName: "mcp-connector-prod-us-east-1",
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
    // Three files: fly.toml (config), fly-deploy.sh (runnable one-command
    // deploy), fly-secrets-hint.sh (paste-friendly hint doc for step-by-step
    // walkthroughs). The runnable script was added post-merge — its absence
    // was a UX flaw that broke the "just run the script" story.
    expect(files.map((f) => f.path)).toEqual(["fly.toml", "fly-deploy.sh", "fly-secrets-hint.sh"]);

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

    // Phase-B bug B4 fix: fly proxy tunnels to the mesh IP, not loopback.
    // The scaffold-generated fly.toml MUST set INSPECTOR_BIND_ADDR=:: or
    // the operator can't reach the inspector via `fly proxy`. Pinned as
    // an active TOML assignment so a comment mention doesn't satisfy it.
    expect(toml.content).toMatch(/^\s*INSPECTOR_BIND_ADDR\s*=\s*"::"/m);

    // Post-merge tweak: source-build is the ONLY working path today
    // because no public image is published. `dockerfile =` MUST be the
    // ACTIVE build line; `image =` must be commented out. Line-start
    // regex distinguishes active TOML from the comment mention.
    expect(toml.content).toMatch(/^\s*dockerfile\s*=\s*"packages\/connector\/Dockerfile"/m);
    // Companion: the image = line must be inside a comment (# prefix).
    // Assert BOTH: (a) an active image= line does NOT exist, and
    // (b) a commented image= line DOES exist.
    expect(toml.content).not.toMatch(/^\s*image\s*=\s*"/m);
    expect(toml.content).toMatch(/^\s*#\s+image\s*=\s*"/m);

    // Post-merge tweak: connector needs a yaml at CONNECTOR_CONFIG or
    // boot fails. Fly's [[files]] block delivers deploy/fly/connector.yaml
    // to /etc/mcp-connector/config.yaml at Machine boot.
    expect(toml.content).toMatch(/^\[\[files\]\]/m);
    expect(toml.content).toContain(`guest_path = "/etc/mcp-connector/config.yaml"`);
    expect(toml.content).toContain(`local_path = "deploy/fly/connector.yaml"`);

    // Post-merge tweak: demo convenience — point drop-in scanner at the
    // in-image tree so sample MCPs auto-appear. Load-bearing for the
    // out-of-box demo experience; commented instructions tell real
    // customers when to remove it.
    expect(toml.content).toMatch(/^\s*MCP_DROPIN_DIR\s*=\s*"\/app\/mcp\/local"/m);

    // Volume mount for state — belt-and-braces per D3.
    expect(toml.content).toContain(`source = "state"`);
    expect(toml.content).toContain(`destination = "/var/lib/mcp-connector"`);
  });

  it("honors --app-name override for a custom Fly app name (no prefix)", () => {
    // Simulate `deploy init --target fly --name des-fly-test --app-name twilio-tool-sdk`
    // — the app-name is the standalone Fly identity, connector name stays separate.
    const { files } = render("fly", { ...VARS, name: "des-fly-test", appName: "twilio-tool-sdk" });
    const toml = files.find((f) => f.path === "fly.toml")!;
    expect(toml.content).toContain(`app = "twilio-tool-sdk"`);
    // The prefix must NOT sneak back in when appName is a bare name.
    expect(toml.content).not.toContain(`app = "mcp-connector-`);
    // Comments about the app also reference the custom name (not the connector name).
    expect(toml.content).toContain("fly proxy 9090:9090 -a twilio-tool-sdk");
    expect(toml.content).toContain("fly ips list -a twilio-tool-sdk");
  });

  it("propagates custom appName through fly-secrets-hint.sh commands", () => {
    const { files } = render("fly", { ...VARS, name: "des-fly-test", appName: "twilio-tool-sdk" });
    const hint = files.find((f) => f.path === "fly-secrets-hint.sh")!;
    // Every fly CLI command in the hint script must target the custom name,
    // including the derived Postgres app name.
    expect(hint.content).toContain("twilio-tool-sdk-db");
    expect(hint.content).toContain("--app twilio-tool-sdk");
    expect(hint.content).toContain("fly proxy 9090:9090 -a twilio-tool-sdk");
    // Connector identity (CONNECTOR_NAME) stays separate — the inspector
    // configure step still shows `--name` as the controller-side identity.
    expect(hint.content).toContain("Connector Name: des-fly-test");
    // Guard: default prefix must not leak when a custom appName is set.
    expect(hint.content).not.toContain("mcp-connector-twilio-tool-sdk");
    expect(hint.content).not.toContain("mcp-connector-des-fly-test");
  });

  it("emits fly-mock fly.toml + Dockerfile with private-only invariants", () => {
    // Fly-mock's app-name default is `mock-customers-<name>` — computed in
    // scaffold.ts's runDeployInit(). render() is pure, so tests supply appName
    // explicitly. Verifies the template threads appName correctly to a
    // `mock-customers-*` shape.
    const vars = { ...VARS, appName: "mock-customers-prod-us-east-1" };
    const { files } = render("fly-mock", vars);
    expect(files.map((f) => f.path)).toEqual(["fly.toml", "Dockerfile"]);

    const toml = files.find((f) => f.path === "fly.toml")!;
    expect(toml.content).toContain(`app = "mock-customers-prod-us-east-1"`);
    // Internal DNS in comments must reflect appName, not the bare `name`.
    expect(toml.content).toContain("mock-customers-prod-us-east-1.internal");
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

  it("emits fly-secrets-hint.sh with Postgres attach + master key + volume steps", () => {
    const { files } = render("fly", VARS);
    const hint = files.find((f) => f.path === "fly-secrets-hint.sh")!;

    // Postgres must attach as POSTGRES_URL, not the default DATABASE_URL —
    // the connector's env reader looks for POSTGRES_URL. Bug B3.
    expect(hint.content).toContain("--variable-name POSTGRES_URL");
    expect(hint.content).toContain("--database-name mcp_connector");
    expect(hint.content).toContain("mcp-connector-prod-us-east-1-db");

    // Master key delivery is the entrypoint-decoded env var, not a file.
    expect(hint.content).toContain("CONNECTOR_KEY_B64");
    expect(hint.content).toContain("head -c 32 /dev/urandom | base64");

    // Inspector reach is `fly proxy`, not any public exposure.
    expect(hint.content).toContain("fly proxy 9090:9090 -a mcp-connector-prod-us-east-1");
    expect(hint.content).toContain("https://controller.example.com");

    // Phase-B bug B5 fix: `fly deploy 2>&1 | tail` silently buffers because
    // Fly's Depot builder only flushes on TTY. Hint must show the direct-file
    // redirect + tail -f pattern so operators can watch build progress live.
    expect(hint.content).toContain("nohup fly deploy > /tmp/fly-deploy.log");
    expect(hint.content).toContain("tail -f /tmp/fly-deploy.log");
  });

  it("emits fly-deploy.sh as a runnable, idempotent one-command deploy", () => {
    const { files } = render("fly", VARS);
    const sh = files.find((f) => f.path === "fly-deploy.sh")!;
    expect(sh).toBeDefined();

    // Load-bearing: the whole point of this file is that `bash fly-deploy.sh`
    // just works. The shebang + strict-mode pragmas are the minimum shape.
    expect(sh.content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(sh.content).toContain("set -euo pipefail");

    // App-name substitution — the script MUST reference the specific app the
    // scaffold was generated for, not the generic `{{APP_NAME}}` placeholder.
    // If substitution regressed, the script would try to create an app named
    // literally "{{APP_NAME}}".
    expect(sh.content).toContain(`APP="mcp-connector-prod-us-east-1"`);
    expect(sh.content).toContain(`DB_APP="mcp-connector-prod-us-east-1-db"`);
    expect(sh.content).not.toContain("{{APP_NAME}}");
    expect(sh.content).not.toContain("{{NAME}}");

    // Bug B3 — Postgres MUST be attached with --variable-name POSTGRES_URL.
    // The default DATABASE_URL is invisible to the connector's env reader.
    // Pinning here catches template drift that reverts to Fly's default.
    expect(sh.content).toContain("--variable-name POSTGRES_URL");

    // Idempotency — re-running after a mid-step failure must not fail on
    // "app already exists" style errors. Each mutation checks state first.
    expect(sh.content).toContain("already exists — skipping create");
    expect(sh.content).toContain("already set — skipping mint");

    // Master key mint — 32 bytes from /dev/urandom, base64-encoded, set
    // as CONNECTOR_KEY_B64 (entrypoint decodes to CONNECTOR_KEY_FILE).
    expect(sh.content).toContain("head -c 32 /dev/urandom | base64");
    expect(sh.content).toContain("CONNECTOR_KEY_B64");

    // The final `fly deploy` runs in the foreground. The B5 nohup+tail-f
    // pattern is in fly-secrets-hint.sh for the step-by-step path.
    expect(sh.content).toMatch(/^fly deploy$/m);

    // Preflight — creates deploy/fly/connector.yaml if missing so first-time
    // operators don't hit the [[files]] block's local_path resolution failure.
    expect(sh.content).toContain("deploy/fly/connector.yaml");
    expect(sh.content).toContain("mcp_servers: []");
  });

  it("propagates custom appName into fly-deploy.sh", () => {
    // Companion to the existing fly-secrets-hint appName test — same
    // guarantee for the runnable script.
    const { files } = render("fly", { ...VARS, name: "des-fly-test", appName: "twilio-tool-sdk" });
    const sh = files.find((f) => f.path === "fly-deploy.sh")!;
    expect(sh.content).toContain(`APP="twilio-tool-sdk"`);
    expect(sh.content).toContain(`DB_APP="twilio-tool-sdk-db"`);
    // Default prefix must not leak when a custom appName is set.
    expect(sh.content).not.toContain("mcp-connector-twilio-tool-sdk");
    expect(sh.content).not.toContain("mcp-connector-des-fly-test");
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

  it("writes fly.toml + fly-deploy.sh + fly-secrets-hint.sh to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-fly-"));
    try {
      const result = await scaffoldTo("fly", VARS, outDir);
      expect(result.written).toHaveLength(3);
      const toml = readFileSync(join(outDir, "fly.toml"), "utf8");
      expect(toml).toContain("prod-us-east-1");
      // Runnable deploy script — verify it landed on disk with the right
      // shape (shebang + strict-mode pragmas). Not asserting exec bit; the
      // scaffold writes with default perms and operators run via `bash file.sh`.
      const sh = readFileSync(join(outDir, "fly-deploy.sh"), "utf8");
      expect(sh).toMatch(/^#!\/usr\/bin\/env bash/);
      expect(sh).toContain("set -euo pipefail");
      const hint = readFileSync(join(outDir, "fly-secrets-hint.sh"), "utf8");
      expect(hint).toContain("CONNECTOR_KEY_B64");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("writes fly-mock fly.toml + Dockerfile to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-fly-mock-"));
    try {
      // scaffoldTo is pure over ScaffoldVars — the fly-mock default
      // (`mock-customers-<name>`) is computed in runDeployInit, not here,
      // so tests supply appName explicitly.
      const vars = { ...VARS, appName: "mock-customers-prod-us-east-1" };
      const result = await scaffoldTo("fly-mock", vars, outDir);
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

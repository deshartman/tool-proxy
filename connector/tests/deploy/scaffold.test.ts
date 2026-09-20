import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scaffoldTo, normalizeControllerUrl } from "../../src/deploy/scaffold.js";
import { render, type ScaffoldVars } from "../../src/deploy/templates.js";
import { vi } from "vitest";

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

  it("emits a readme appendix telling the customer what to do next", () => {
    for (const target of ["fargate", "gke", "aca", "compose", "fly", "fly-mock"] as const) {
      const { readmeAppendix } = render(target, VARS);
      expect(readmeAppendix.length, `${target} appendix`).toBeGreaterThan(50);
    }
  });

  it("emits fly.toml with substituted app name + image and NO public service", () => {
    const { files } = render("fly", VARS);
    // Fly target emits ONE file: fly.toml. The deploy step is a separate
    // CLI verb (`mcp-connector deploy apply --target fly`), which reads
    // this fly.toml and spawns fly commands directly. Historical: earlier
    // iterations emitted `fly-deploy.sh` + `fly-secrets-hint.sh` alongside,
    // but that produced a confusing three-artifact surface — the customer
    // wondered which one to run. Consolidating to one file (init) + one
    // command (apply) matches the terraform init/apply pattern.
    expect(files.map((f) => f.path)).toEqual(["fly.toml"]);

    const toml = files.find((f) => f.path === "fly.toml")!;
    expect(toml.content).toContain(`app = "mcp-connector-prod-us-east-1"`);
    expect(toml.content).toContain(`image = "ghcr.io/twilio/mcp-connector:0.2.0"`);

    // Load-bearing invariants — outbound-only, no scale-to-zero, no public IP.
    // If any of these regress as ACTIVE toml (not a comment mention),
    // the deploy silently starts leaking the bcrypt-protected webhook URLs
    // or dying at first idle. Match line-start to allow the file to still
    // *mention* the invariants in its own reminder comments.
    expect(toml.content).not.toMatch(/^\[\[services\]\]/m);
    expect(toml.content).not.toMatch(/^\[http_service\]/m);
    expect(toml.content).not.toMatch(/^\s*auto_stop_machines\s*=/m);

    // fly proxy tunnels to the mesh IP, not loopback, so the default
    // 127.0.0.1 bind is unreachable over `.internal` DNS. The scaffolded
    // fly.toml MUST set INSPECTOR_BIND_ADDR=:: or the MACHINE API
    // (/oauth/token, /v1/*) stops answering for the controller. It does not
    // make the dashboard reachable — that requires a loopback caller no
    // matter how wide the bind. Pinned as an active TOML assignment so a
    // comment mention doesn't satisfy it.
    expect(toml.content).toMatch(/^\s*INSPECTOR_BIND_ADDR\s*=\s*"::"/m);

    // Post-merge tweak: source-build is the ONLY working path today
    // because no public image is published. `dockerfile =` MUST be the
    // ACTIVE build line; `image =` must be commented out. Line-start
    // regex distinguishes active TOML from the comment mention.
    expect(toml.content).toMatch(/^\s*dockerfile\s*=\s*"connector\/Dockerfile"/m);
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

    // MCP_DROPIN_DIR must NOT be set, and this assertion was inverted
    // deliberately. It once pointed the CUSTOMER drop-in scanner at an
    // in-image /app/mcp/local tree so demo MCPs auto-appeared. That tree was
    // renamed to bundled-mcps/ and is now discovered via MCP_BUNDLED_DIR
    // (always-on), so the var became vestigial — and then actively harmful:
    // it aimed the scanner at a path that no longer exists, silently
    // disabling customer drop-in discovery AND the "Refresh local MCPs"
    // rescan on every Fly deployment. Nothing broke visibly because the
    // demos still arrived via the bundled path. Unset means the default
    // (/var/lib/mcp-connector/customer-mcps/) applies, which is inside the
    // [[mounts]] volume. Matched at line-start so the file may still
    // explain itself in a comment.
    expect(toml.content).not.toMatch(/^\s*MCP_DROPIN_DIR\s*=/m);

    // The image bundles four Type 1 demo MCPs, and tsx spawns THREE processes
    // per child (wrapper node + real node + a resident esbuild service), so
    // each child costs ~118 MB RSS. Measured on a live 512 MB machine:
    // connector 72 MB + 3 children + Fly hallpass = 442 of 459 MB usable,
    // 30 MB free, zero swap — the FOURTH child could not allocate, stalled
    // without ever binding or logging, and was SIGTERMed by the readiness
    // probe (exit 143). Raising MCP_READINESS_TIMEOUT_MS does NOT fix that:
    // the memory is absent, not late. 512 MB cannot run the shipped image.
    // Pinned as a lower bound, not an exact string, so sizing up is free.
    const mem = /^\s*memory\s*=\s*"(\d+)(mb|gb)"/m.exec(toml.content);
    expect(mem, "fly.toml must declare [[vm]] memory").not.toBeNull();
    const mib = mem[2] === "gb" ? Number(mem[1]) * 1024 : Number(mem[1]);
    expect(mib, "512 MB cannot boot the 4 bundled MCPs — see comment above").toBeGreaterThanOrEqual(1024);

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
    // Comments about the app also reference the custom name (not the connector
    // name). `fly ips list -a <app>` is the witness for that substitution.
    expect(toml.content).toContain("fly ips list -a twilio-tool-sdk");
    // The witness used to be `fly proxy 9090:9090 -a <app>`, which the header
    // gave as the way to reach the inspector. That instruction stopped working
    // when the request gate landed (fly proxy arrives from the Machine's fdaa:
    // mesh address; the dashboard requires a loopback caller), so it is gone
    // from the template and must not come back.
    expect(toml.content).not.toContain("fly proxy 9090:9090");
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

});

describe("normalizeControllerUrl", () => {
  // Customer-facing UX lesson (2026-07-23): operators paste the "connect
  // your connector" URL from the controller UI verbatim, which includes
  // the `/mcp-tunnel` path. The connector appends that path itself in
  // tunnel/client.ts, so the yaml/env value must be the HTTPS root only.
  // Without normalization, the connector dials wss://.../mcp-tunnel/mcp-tunnel
  // and silently fails to open the WS — no boot error, no obvious symptom.
  //
  // Defensive strip lives in scaffold.ts. Not a URL parser — only handles
  // the one path we know breaks. Loud warn to stderr so the operator
  // notices we corrected their paste.

  it("strips a trailing /mcp-tunnel path from the controller URL", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(normalizeControllerUrl("https://controller.example.com/mcp-tunnel")).toBe(
      "https://controller.example.com",
    );
    // Warning must be visible — silent strip would confuse operators
    // whose paste doesn't match the emitted config.
    const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderrText).toContain('Stripping "/mcp-tunnel"');
    vi.restoreAllMocks();
  });

  it("strips trailing slashes even when path is present", () => {
    // `https://controller.example.com/mcp-tunnel/` — trailing slash after
    // the path we want to strip. Normalize the slash first, then strip.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(normalizeControllerUrl("https://controller.example.com/mcp-tunnel/")).toBe(
      "https://controller.example.com",
    );
    vi.restoreAllMocks();
  });

  it("leaves the URL alone when it's already the bare root", () => {
    // No warning, no changes — this is the happy path.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(normalizeControllerUrl("https://controller.example.com")).toBe(
      "https://controller.example.com",
    );
    expect(stderrSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("strips a bare trailing slash", () => {
    // `https://controller.example.com/` — common shell autocomplete
    // artifact. No warning; just a hygiene trim.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(normalizeControllerUrl("https://controller.example.com/")).toBe(
      "https://controller.example.com",
    );
    expect(stderrSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does NOT touch unrelated paths (defensive, not aggressive)", () => {
    // Only /mcp-tunnel is the known-broken suffix. Other paths might be
    // legitimate custom routes; the connector will fail-loud on those
    // rather than silently mangling them. If a customer needs to point
    // at something other than /mcp-tunnel, that's a controller-side
    // configuration story, not a scaffold input.
    expect(normalizeControllerUrl("https://controller.example.com/custom-path")).toBe(
      "https://controller.example.com/custom-path",
    );
  });
});

describe("scaffoldTo — file writes", () => {
  it("writes all target files to the given outDir", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-"));
    try {
      const result = await scaffoldTo("compose", VARS, outDir);
      expect(result.written).toHaveLength(2);
      // Boot viability, not substitution. This used to assert the connector
      // NAME appeared in the compose file and `TUNNEL_AUTH_TOKEN=` in the
      // .env — both retired, and both the kind of assertion that stays green
      // while the emitted stack crash-loops. What matters is the one env var
      // requireEnv() demands, and the image reference.
      const compose = readFileSync(join(outDir, "docker-compose.yml"), "utf8");
      expect(compose).toContain("CONNECTOR_KEY_FILE:");
      expect(compose).toContain("ghcr.io/twilio/mcp-connector:0.2.0");
      // No unsubstituted placeholders survived.
      expect(compose).not.toMatch(/\{\{[A-Z_]+\}\}/);
      const env = readFileSync(join(outDir, ".env.example"), "utf8");
      // The template now carries no assignments at all — every line is a
      // comment or blank. An uncommented KEY= line means a credential crept
      // back into a file operators paste into.
      for (const line of env.split("\n")) {
        expect(line, `unexpected assignment in .env.example: ${line}`)
          .not.toMatch(/^\s*[A-Z][A-Z0-9_]*=/);
      }
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
      expect(readFileSync(join(outDir, "docker-compose.yml"), "utf8"))
        .toContain("CONNECTOR_KEY_FILE:");
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

  it("writes fly.toml to the given outDir (single-file target)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scaffold-fly-"));
    try {
      const result = await scaffoldTo("fly", VARS, outDir);
      // Fly emits exactly one file. The deploy is a separate CLI verb
      // (`mcp-connector deploy apply --target fly`), not a script emitted
      // alongside fly.toml.
      expect(result.written).toHaveLength(1);
      const toml = readFileSync(join(outDir, "fly.toml"), "utf8");
      expect(toml).toContain("prod-us-east-1");
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

// CONNECTOR_STATE_PATH was set by every deploy target and read by nothing.
// It pointed at the connector's persisted registration token, which moved to
// Postgres when `env` mode was removed — the token now lives in the sealed
// `controllers` row and is cleared via ConfigStore.clearRegistrationToken.
// Left in place it invited two wrong conclusions: that the connector needs a
// writable file on the state volume, and that /var/lib/mcp-connector must be
// mounted for the tunnel identity to survive a restart. Neither is true.
describe("render — no dead CONNECTOR_STATE_PATH in any target", () => {
  const TARGETS = ["fargate", "gke", "aca", "compose", "fly", "fly-mock"] as const;

  for (const target of TARGETS) {
    it(`${target} sets no CONNECTOR_STATE_PATH`, () => {
      const { files } = render(target, { ...VARS });
      for (const f of files) {
        expect(f.content, `${target}/${f.path} still sets it`).not.toContain("CONNECTOR_STATE_PATH");
      }
    });
  }

  it("fargate's task definition is still valid JSON after the removal", () => {
    // It was the LAST element of the environment array, so deleting the line
    // alone would leave a trailing comma on the line above — invalid JSON that
    // no other assertion here would catch.
    const { files } = render("fargate", { ...VARS });
    const task = files.find((f) => f.path === "task-definition.json")!;
    expect(() => JSON.parse(task.content)).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

// The Terraform module and Helm chart ship as customer-runnable artefacts.
// This suite covers two layers:
//   1. Filesystem: expected files exist, contain the load-bearing strings
//      (variable names, invariant references). This catches template drift
//      without needing terraform/helm installed.
//   2. Tool-driven: when terraform / helm is on PATH, run `validate` /
//      `lint` and assert exit 0. Skipped otherwise — CI installs both;
//      dev machines rarely do.

const REPO_ROOT = resolvePath(new URL("../../../", import.meta.url).pathname);
const TF_DIR = resolvePath(REPO_ROOT, "deploy/terraform/aws-fargate");
const HELM_DIR = resolvePath(REPO_ROOT, "deploy/helm/mcp-connector");

function toolAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("terraform module — filesystem invariants", () => {
  it("ships versions.tf, variables.tf, main.tf, outputs.tf, README.md", () => {
    const files = new Set(readdirSync(TF_DIR));
    for (const expected of ["versions.tf", "variables.tf", "main.tf", "outputs.tf", "README.md"]) {
      expect(files, `${expected} missing`).toContain(expected);
    }
  });

  it("declares connector_name as a required variable", () => {
    const vars = readFileSync(join(TF_DIR, "variables.tf"), "utf8");
    expect(vars).toContain(`variable "connector_name"`);
    // No default — customer must set it. If a default sneaks in, someone
    // will `terraform apply` a stub name that doesn't match the row.
    const block = vars.slice(vars.indexOf(`variable "connector_name"`));
    const upToNext = block.slice(0, block.indexOf(`variable "`, 1));
    expect(upToNext).not.toMatch(/^\s*default\s*=/m);
  });

  it("hardcodes desired_count=1 (dup-name guard)", () => {
    const main = readFileSync(join(TF_DIR, "main.tf"), "utf8");
    // Two replicas would open two tunnels and trip the controller's
    // dup-name guard. This must not be templated.
    expect(main).toMatch(/desired_count\s*=\s*1/);
  });

  it("provisions Secrets Manager slot without a managed value", () => {
    const main = readFileSync(join(TF_DIR, "main.tf"), "utf8");
    // The value lands via `aws secretsmanager put-secret-value` out-of-band.
    // If a `secret_string` argument appears, the bearer leaks into tfstate.
    expect(main).toContain(`aws_secretsmanager_secret" "tunnel_auth_token"`);
    expect(main).not.toMatch(/^\s*secret_string\s*=/m);
  });

  const tfTest = toolAvailable("terraform") ? it : it.skip;
  tfTest("passes `terraform validate`", () => {
    // `terraform init -backend=false` is required before validate; both
    // must be quick. Test skips entirely when terraform isn't installed.
    execFileSync("terraform", ["init", "-backend=false", "-input=false"], {
      cwd: TF_DIR,
      stdio: "pipe",
    });
    execFileSync("terraform", ["validate"], { cwd: TF_DIR, stdio: "pipe" });
  });
});

describe("helm chart — filesystem invariants", () => {
  it("ships Chart.yaml + values.yaml + templates/*", () => {
    expect(existsSync(join(HELM_DIR, "Chart.yaml"))).toBe(true);
    expect(existsSync(join(HELM_DIR, "values.yaml"))).toBe(true);
    const templates = new Set(readdirSync(join(HELM_DIR, "templates")));
    for (const expected of ["_helpers.tpl", "secret.yaml", "pvc.yaml", "deployment.yaml"]) {
      expect(templates, `templates/${expected} missing`).toContain(expected);
    }
  });

  it("emits replicas: 1 hardcoded (never templated)", () => {
    const deployment = readFileSync(join(HELM_DIR, "templates/deployment.yaml"), "utf8");
    // If replicas ever gets a `.Values.replicaCount`, a customer will scale
    // to 2 and hit the dup-name guard.
    expect(deployment).toMatch(/^\s*replicas:\s*1\s*$/m);
    expect(deployment).not.toMatch(/replicas:\s*\{\{/);
  });

  it("does NOT render a Service for the inspector port by default", () => {
    // CONNECTOR-NETWORK-EXPOSURE added templates/service.yaml, gated
    // behind .Values.networkAccess.enabled (default false). A Service
    // targeting port 9090 is no longer inherently unsafe: only
    // POST /oauth/token ever answers a non-loopback request (gated by a
    // machine caller's own client_id/client_secret), and only once an
    // operator has added at least one API client from the inspector's
    // loopback session — the dashboard itself never becomes reachable
    // this way. The invariant that still matters is "off by default",
    // not "can never exist" — see architectural-plans/CONNECTOR-NETWORK-EXPOSURE.md.
    const values = readFileSync(join(HELM_DIR, "values.yaml"), "utf8");
    expect(values).toMatch(/networkAccess:\s*\n\s*enabled:\s*false/);

    const serviceTemplate = readFileSync(join(HELM_DIR, "templates/service.yaml"), "utf8");
    const ifIndex = serviceTemplate.indexOf("{{- if .Values.networkAccess.enabled }}");
    const kindIndex = serviceTemplate.indexOf("kind: Service");
    expect(ifIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(ifIndex);

    // Every OTHER template must still never declare a Service outright.
    const templates = readdirSync(join(HELM_DIR, "templates")).filter((t) => t !== "service.yaml");
    for (const tpl of templates) {
      const content = readFileSync(join(HELM_DIR, "templates", tpl), "utf8");
      expect(content, `${tpl} must not declare a Service`).not.toMatch(/^kind:\s*Service\b/m);
    }
  });

  const helmServiceTest = toolAvailable("helm") ? it : it.skip;
  helmServiceTest("`helm template` renders no Service by default, and one when networkAccess.enabled=true", () => {
    const baseArgs = [
      "template", "release-name", HELM_DIR,
      "--set", "connector.name=render-test",
      "--set", "connector.controllerUrl=https://ctrl.example.com",
      "--set", "secrets.tunnelAuthToken=ts_render",
    ];
    const withoutFlag = execFileSync("helm", baseArgs, { encoding: "utf8" });
    expect(withoutFlag).not.toMatch(/^kind:\s*Service\b/m);

    const withFlag = execFileSync("helm", [...baseArgs, "--set", "networkAccess.enabled=true"], { encoding: "utf8" });
    expect(withFlag).toMatch(/^kind:\s*Service\b/m);
  });

  it("requires connector.name and connector.controllerUrl to be set", () => {
    const deployment = readFileSync(join(HELM_DIR, "templates/deployment.yaml"), "utf8");
    // Helm's `required` template function surfaces a clean error at
    // `helm install` time instead of shipping an empty CONNECTOR_NAME.
    expect(deployment).toMatch(/required\s+"connector\.name is required"/);
    expect(deployment).toMatch(/required\s+"connector\.controllerUrl is required"/);
  });

  const helmTest = toolAvailable("helm") ? it : it.skip;
  helmTest("passes `helm lint`", () => {
    // Lint uses the default values which have empty connector.name; supply
    // the required values via --set so the required{} calls succeed.
    execFileSync("helm", [
      "lint",
      HELM_DIR,
      "--set", "connector.name=lint-test",
      "--set", "connector.controllerUrl=https://ctrl.example.com",
      "--set", "secrets.tunnelAuthToken=ts_lint",
    ], { stdio: "pipe" });
  });

  helmTest("templates into valid k8s manifests", () => {
    const output = execFileSync("helm", [
      "template",
      "release-name",
      HELM_DIR,
      "--set", "connector.name=render-test",
      "--set", "connector.controllerUrl=https://ctrl.example.com",
      "--set", "secrets.tunnelAuthToken=ts_render",
    ], { encoding: "utf8" });
    // Assert the substituted values landed in the render.
    expect(output).toContain("render-test");
    expect(output).toContain("https://ctrl.example.com");
  });
});

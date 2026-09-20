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

// Every `required` value the chart declares, in one place so a rename touches
// one line. A render missing any of these fails with Helm's own error, which
// is why the earlier version of this file silently failed wherever helm was
// actually installed: it set three retired values and never set image.tag.
const REQUIRED_SETS = [
  "--set", "image.tag=9.9.9-test",
  // 32 zero bytes, base64. A literal is fine — it is never used to seal
  // anything here, and minting a real key in a test would be theatre.
  "--set", `secrets.connectorKeyB64=${Buffer.alloc(32).toString("base64")}`,
];

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
    // If a `secret_string` argument appears, the secret leaks into tfstate —
    // often an S3 bucket with looser permissions than Secrets Manager itself.
    //
    // The secret is now the master key, not a tunnel bearer: the bearer moved
    // into the inspector's Configure Tunnel modal and is sealed under this key.
    expect(main).toContain(`aws_secretsmanager_secret" "connector_key"`);
    expect(main).not.toMatch(/^\s*secret_string\s*=/m);
    // Comments are allowed to name the retired secret to explain its removal;
    // resources are not.
    const code = main.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toContain("tunnel_auth_token");
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
    const baseArgs = ["template", "release-name", HELM_DIR, ...REQUIRED_SETS];
    const withoutFlag = execFileSync("helm", baseArgs, { encoding: "utf8" });
    expect(withoutFlag).not.toMatch(/^kind:\s*Service\b/m);

    const withFlag = execFileSync("helm", [...baseArgs, "--set", "networkAccess.enabled=true"], { encoding: "utf8" });
    expect(withFlag).toMatch(/^kind:\s*Service\b/m);
  });

  it("requires exactly the two values a render cannot invent", () => {
    // Helm's `required` surfaces a clean error at install time instead of
    // shipping an empty variable. The set shrank: connector.name,
    // connector.controllerUrl and secrets.tunnelAuthToken / postgresUrl were
    // all `required` here and all retired — so `helm install` demanded four
    // values the connector would ignore, and could not succeed at all.
    // Identity now arrives through the inspector's Configure Tunnel modal.
    const deployment = readFileSync(join(HELM_DIR, "templates/deployment.yaml"), "utf8");
    const secret = readFileSync(join(HELM_DIR, "templates/secret.yaml"), "utf8");
    expect(deployment).toMatch(/required\s+"image\.tag is required/);
    expect(secret).toMatch(/required\s+"secrets\.connectorKeyB64 is required/);
    for (const dead of ["connector.name", "connector.controllerUrl", "secrets.tunnelAuthToken", "secrets.postgresUrl"]) {
      expect(deployment + secret, `${dead} is still required`)
        .not.toContain(`required "${dead}`);
    }
  });

  // The helm-gated tests below skip wherever helm is absent — which is most
  // dev machines and was how REQUIRED_SETS drifted out of sync with the chart
  // unnoticed, leaving three renders that could only ever fail. This check
  // needs no helm, so it runs everywhere and keeps the two in step.
  it("REQUIRED_SETS supplies every value the chart marks required", () => {
    const templateDir = join(HELM_DIR, "templates");
    const declared = new Set<string>();
    for (const f of readdirSync(templateDir).filter((x) => x.endsWith(".yaml"))) {
      const text = readFileSync(join(templateDir, f), "utf8");
      for (const m of text.matchAll(/required\s+"(?:[^"\\]|\\.)*"\s+\.Values\.([A-Za-z0-9_.]+)/g)) {
        declared.add(m[1]!);
      }
    }
    const supplied = new Set(
      REQUIRED_SETS.filter((a) => a !== "--set").map((a) => a.slice(0, a.indexOf("="))),
    );
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...supplied].sort());
  });

  const helmTest = toolAvailable("helm") ? it : it.skip;
  helmTest("passes `helm lint`", () => {
    // Lint uses the default values, where both `required` keys are empty;
    // supply them via --set so the required{} calls succeed.
    execFileSync("helm", ["lint", HELM_DIR, ...REQUIRED_SETS], { stdio: "pipe" });
  });

  helmTest("templates into valid k8s manifests", () => {
    const output = execFileSync("helm", ["template", "release-name", HELM_DIR, ...REQUIRED_SETS], {
      encoding: "utf8",
    });
    // Boot viability, not substitution. The prior version asserted the
    // connector name and controller URL landed in the render; neither is an
    // env var any more, so that check would pass on a chart that renders a
    // pod which cannot open its config store.
    expect(output).toContain("name: CONNECTOR_KEY_FILE");
    expect(output).toContain("CONNECTOR_KEY_B64:");
    expect(output).toContain("mcp-connector:9.9.9-test");
  });
});

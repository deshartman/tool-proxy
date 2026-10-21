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
const TF_SCRATCH_DIR = resolvePath(TF_DIR, "examples/from-scratch");
const TF_EC2_DIR = resolvePath(REPO_ROOT, "deploy/terraform/aws-ec2");
const HELM_DIR = resolvePath(REPO_ROOT, "deploy/helm/tool-proxy");

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

// Probe with `<bin> version` FIRST, then `--version`.
//
// This was `["--version"]` alone, and helm 4 removed that flag — `helm
// --version` exits 1 while `helm version` exits 0. So on any machine with helm 4
// installed and working, every helm-gated test below reported itself SKIPPED
// rather than failing, which is the worst available outcome: a green suite that
// proved nothing about the chart. CI installs helm, so CI was skipping them too.
//
// Both spellings are tried because `terraform version` and `terraform
// --version` both work, but a future tool may only accept one.
function toolAvailable(bin: string): boolean {
  for (const args of [["version"], ["--version"]]) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
      return true;
    } catch {
      // try the next spelling
    }
  }
  return false;
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

  // Both directories, because they fail independently: the example composes the
  // core module, so it also catches an input the module renamed. Note what
  // `validate` does NOT catch — every defect the DB-TO-FILE work fixed in the
  // core module was valid HCL, which is why
  // tests/iac/terraform-fargate-boot.test.ts exists alongside this.
  for (const [label, dir] of [
    ["core module", TF_DIR],
    ["from-scratch example", TF_SCRATCH_DIR],
    ["ec2 module", TF_EC2_DIR],
  ] as const) {
    tfTest(`passes \`terraform validate\` — ${label}`, () => {
      // `terraform init -backend=false` is required before validate; both must
      // be quick. Skips entirely when terraform isn't installed.
      execFileSync("terraform", ["init", "-backend=false", "-input=false"], {
        cwd: dir,
        stdio: "pipe",
      });
      execFileSync("terraform", ["validate"], { cwd: dir, stdio: "pipe" });
    });
  }
});

// The from-scratch example exists because the core module deliberately owns no
// networking, so an operator with only an AWS account had no complete path. It
// must keep supplying every input the module requires — a rename on either side
// breaks the composition, and `terraform validate` only catches that when
// terraform is installed (it usually is not, on a dev machine).
describe("terraform from-scratch example — composes the core module completely", () => {
  const main = readFileSync(join(TF_SCRATCH_DIR, "main.tf"), "utf8");
  const moduleVars = readFileSync(join(TF_DIR, "variables.tf"), "utf8");

  const requiredInputs = [...moduleVars.matchAll(/variable "([a-z_]+)" \{([^}]*)\}/gs)]
    .filter((m) => !/^\s*default\s*=/m.test(m[2]!))
    .map((m) => m[1]!);

  it("finds the module's required inputs (guards against a broken regex)", () => {
    expect(requiredInputs).toContain("connector_name");
    expect(requiredInputs).toContain("vpc_id");
    expect(requiredInputs.length).toBeGreaterThanOrEqual(6);
  });

  it.each(requiredInputs)("passes %s to the module", (input) => {
    const block = main.slice(main.indexOf('module "connector"'));
    expect(block, `module block does not set ${input}`).toMatch(
      new RegExp(`^\\s*${input}\\s*=`, "m"),
    );
  });

  it("creates the resources an IAM-account-only operator lacks", () => {
    for (const resource of [
      "aws_vpc",
      "aws_subnet",
      "aws_internet_gateway",
      "aws_route_table",
      "aws_ecs_cluster",
      "aws_ecr_repository",
    ]) {
      expect(main, `missing ${resource}`).toContain(`resource "${resource}"`);
    }
    // Two roles, not one: secret injection is the EXECUTION role's job and the
    // EFS mount plus ECS Exec are the TASK role's. Conflating them produces a
    // task that starts and then fails on a missing env var.
    expect(main).toContain('resource "aws_iam_role" "execution"');
    expect(main).toContain('resource "aws_iam_role" "task"');
  });

  it("grants the four ssmmessages actions ECS Exec needs", () => {
    // Without these, `aws ecs execute-command` fails with a
    // TargetNotConnectedException that says nothing about IAM — and ECS Exec is
    // the ONLY way to reach Configure Tunnel, which is the only way to set
    // tunnel identity. So omitting them makes first-connect impossible.
    for (const action of [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]) {
      expect(main, `task role missing ${action}`).toContain(action);
    }
  });

  it("opens no inbound port on the task security group", () => {
    const sg = main.slice(main.indexOf('resource "aws_security_group" "task"'));
    const body = sg.slice(0, sg.indexOf("\n}"));
    expect(body).toMatch(/egress\s*\{/);
    expect(body, "the outbound-only invariant is an ABSENCE of ingress").not.toMatch(/ingress\s*\{/);
  });

  it("refuses a floating image tag", () => {
    // A restart would otherwise become an unplanned upgrade of a process whose
    // whole job is holding one long-lived socket.
    const variables = readFileSync(join(TF_SCRATCH_DIR, "variables.tf"), "utf8");
    expect(variables).toMatch(/condition\s*=\s*var\.image_tag != "latest"/);
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
    expect(output).toContain("tool-proxy:9.9.9-test");
  });
});

// The EC2 module exists because `iam:PassRole` is denied on a standard PowerUser
// permission set, which closes Fargate. Its whole value rests on needing no IAM
// and opening no inbound port — two properties that a well-meaning edit ("just
// add SSM", "open 22 so I can get in") would quietly destroy, leaving a module
// that still applies cleanly.
describe("terraform aws-ec2 — no IAM, no inbound surface", () => {
  const EC2_DIR = resolvePath(REPO_ROOT, "deploy/terraform/aws-ec2");
  const main = readFileSync(join(EC2_DIR, "main.tf"), "utf8");

  const code = main
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  it("the comment-stripper works (guards against vacuous passes)", () => {
    expect(main).toMatch(/^\s*#/m);
    expect(code).not.toMatch(/^\s*#/m);
    expect(code).toContain('resource "aws_instance"');
  });

  it("attaches no instance profile", () => {
    // The entire reason this module works: attaching one needs iam:PassRole.
    expect(code).not.toMatch(/iam_instance_profile/);
  });

  it("creates no IAM resource of any kind", () => {
    expect(code).not.toMatch(/resource "aws_iam_/);
  });

  it("admits only the EIC endpoint on 22, never a CIDR", () => {
    // Slice the ingress BLOCK, not the resource: `indexOf("\n}")` stops at the
    // first nested block's brace, which yielded an empty string and a test that
    // would have passed on an empty file.
    const sg = code.slice(code.indexOf('resource "aws_security_group" "instance"'));
    const ingressStart = sg.indexOf("ingress {");
    const ingress = sg.slice(ingressStart, sg.indexOf("egress {", ingressStart));
    expect(ingress, "ingress block not found").not.toBe("");
    expect(ingress).toMatch(/from_port\s*=\s*22/);
    expect(ingress).toMatch(/security_groups\s*=\s*\[aws_security_group\.eice\.id\]/);
    // A CIDR on the ingress rule is how this becomes internet-facing SSH.
    expect(ingress, "instance ingress must not use a CIDR").not.toMatch(/cidr_blocks/);
  });

  it("never opens 9090 inbound", () => {
    // The tunnel carries 9090 over the same SSH channel, so a rule for it buys
    // nothing and would publish the Webhooks panel's bcrypt-protected URLs.
    expect(code).not.toMatch(/from_port\s*=\s*9090/);
  });

  it("uses no SSH key pair", () => {
    // EICE injects an ephemeral key. A key_name means key material someone has
    // to hold and rotate.
    expect(code).not.toMatch(/key_name/);
  });

  it("requires IMDSv2", () => {
    // v1's unauthenticated GET is reachable from any process on the box,
    // including a compromised MCP child.
    expect(code).toMatch(/http_tokens\s*=\s*"required"/);
  });

  it("encrypts the root volume", () => {
    expect(code).toMatch(/encrypted\s*=\s*true/);
  });

  it("refuses an instance type that cannot build or run the image", () => {
    const variables = readFileSync(join(EC2_DIR, "variables.tf"), "utf8");
    expect(variables).toMatch(/validation\s*\{/);
    expect(variables).toMatch(/nano\|micro/);
  });

  it("tags the image so compose does not try to pull it", () => {
    // The compose file resolves ghcr.io/twilio/tool-proxy:$MCP_VERSION, and
    // ghcr issues no anonymous pull token — so a bare local tag leaves compose
    // failing with an auth error that reads as a network problem.
    expect(code).toMatch(/-t ghcr\.io\/twilio\/tool-proxy:local/);
    // `-f` is REQUIRED: deploy/compose ships docker-compose.prod.yml and
    // .dev.yml but no docker-compose.yml, so a bare `docker compose up` fails
    // with "no configuration file provided". Measured on a live instance.
    expect(code).toMatch(/MCP_VERSION=local docker compose -f docker-compose\.prod\.yml up -d/);
  });

  it("gives the master key a mode the image's uid can read", () => {
    // The single hardest-won line in this module. The compose file mounts the
    // key READ-ONLY, so the entrypoint cannot chown it, and the image's `mcp` is
    // uid 100. A `chmod 400` file owned by anyone else crash-loops the connector
    // on `EACCES: permission denied, open '/etc/tool-proxy/connector.key'`.
    // Docker Desktop on macOS hides this by faking file ownership in its VM;
    // a real Linux host does not.
    expect(code).toMatch(/chown 100:101 secrets\/connector\.key/);
  });

  it("installs the inspector relay before any early exit", () => {
    // The relay bridges host loopback into the container's netns, which is the
    // last hop to the dashboard. It is needed however the code arrives, so it
    // must precede the bootstrap_code early-exit — measured: with the exit
    // first, a bootstrap_code=false instance came up with no relay.
    const relayAt = code.indexOf("mcp-inspector-relay");
    const exitAt = code.indexOf("bootstrap_code ?");
    expect(relayAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(-1);
    expect(relayAt, "relay must install before the early exit").toBeLessThan(exitAt);
  });

  it("creates customer-mcps before compose can mount it", () => {
    // The compose file bind-mounts ../../customer-mcps, which a fresh clone does
    // not contain. Docker would create it root-owned and the scanner could not
    // read it.
    expect(code).toMatch(/mkdir -p \/opt\/tool-proxy\/customer-mcps/);
    // uid 100, NOT 1000. The image's `mcp` user comes from Alpine's
    // `adduser -S`, which assigns a system uid. Measured on a live instance:
    // chowning to 1000 left the connector unable to read its own master key and
    // crash-looping on EACCES.
    expect(code).toMatch(/chown 100:101 \/opt\/tool-proxy\/customer-mcps/);
  });
});

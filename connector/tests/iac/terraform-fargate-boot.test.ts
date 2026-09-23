import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

// The Terraform module and the `deploy init --target fargate` template are two
// independent generators of the same container shape — alternatives for one
// operator decision, not a shared implementation. Both emitted a connector that
// could not boot, and for the SAME reasons, which is exactly what two
// independent generators produce over time.
//
// `terraform` is not installed on most dev machines (and `terraform validate`
// would not catch any of this anyway — every defect below is valid HCL), so
// these are text assertions. They are the only guard this module has.
//
// The defects being pinned, all measured rather than theorised:
//   1. Four retired env vars emitted, and neither required one. CrashLoopBackOff
//      in requireEnv() with logs that point at the operator's secret wiring.
//   2. `memory = "512"` against a measured 493 MB floor. Presents as the fourth
//      MCP child dying at its readiness probe with no output — a broken MCP,
//      not an undersized task.
//   3. `assign_public_ip = false` with the comment "No public IP needed —
//      connector is outbound-only". The task then has NO route to the internet:
//      it cannot pull from ECR and dies with CannotPullContainerError before any
//      connector code runs. Outbound-only describes what reaches the connector.
//   4. An ephemeral `volume { name = "state" }`. Harmless while identity lived
//      in Postgres; since DB-TO-FILE it loses the sealed bearer and registration
//      token on every task restart, and the re-register then collides on the
//      sticky `name_taken`, so unattended recovery is impossible.
//   5. A `config` volume mounted at /etc/mcp-connector — the exact path the
//      entrypoint must WRITE the decoded master key to.

const REPO_ROOT = resolvePath(new URL("../../../", import.meta.url).pathname);
const MODULE_DIR = resolvePath(REPO_ROOT, "deploy/terraform/aws-fargate");

const main = readFileSync(join(MODULE_DIR, "main.tf"), "utf8");
const variables = readFileSync(join(MODULE_DIR, "variables.tf"), "utf8");
const outputs = readFileSync(join(MODULE_DIR, "outputs.tf"), "utf8");

/** HCL with `#` comment lines stripped — the prose explains the removals. */
const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const mainCode = code(main);

describe("terraform aws-fargate — the container can boot", () => {
  it("the comment-stripper works (guards against vacuous passes)", () => {
    // Every negative assertion below runs against stripped code. If the
    // stripper returned the input unchanged, the prose explaining each removal
    // would satisfy the greps and this file would be theatre.
    expect(main).toMatch(/^\s*#/m);
    expect(mainCode).not.toMatch(/^\s*#/m);
    expect(mainCode).toContain("aws_ecs_task_definition");
  });

  it("sets the one env var requireEnv() demands", () => {
    expect(mainCode).toContain("CONNECTOR_KEY_FILE");
  });

  it("supplies the master key as a secret", () => {
    expect(mainCode).toContain("CONNECTOR_KEY_B64");
    expect(mainCode).toContain("aws_secretsmanager_secret");
  });

  it.each(["CONNECTOR_NAME", "CONTROLLER_URL", "TUNNEL_AUTH_TOKEN", "OAUTH_CLIENT_ID", "POSTGRES_URL"])(
    "emits no %s",
    (retired) => {
      expect(mainCode, `main.tf still emits ${retired}`).not.toContain(retired);
    },
  );

  it("takes no controller_url input", () => {
    // Deleted rather than ignored: an input no resource reads is how the Helm
    // chart came to `required` four dead values.
    expect(code(variables)).not.toContain("controller_url");
  });
});

describe("terraform aws-fargate — sizing", () => {
  const defaultOf = (name: string): string => {
    const block = new RegExp(`variable "${name}"[^}]*?default\\s*=\\s*"?([^"\\n]+)"?`, "s");
    const m = block.exec(variables);
    if (!m) throw new Error(`no default found for variable ${name}`);
    return m[1]!.trim();
  };

  it("the default-extractor works", () => {
    expect(defaultOf("assign_public_ip")).toBe("true");
  });

  it("defaults memory to at least 1024 MiB", () => {
    expect(Number(defaultOf("task_memory"))).toBeGreaterThanOrEqual(1024);
  });

  it("fails at plan time if a caller lowers memory below the floor", () => {
    // A validation block turns "the fourth MCP dies with no output" into an
    // error before anything is created.
    expect(variables).toMatch(/validation\s*\{/);
    expect(variables).toContain("task_memory must be at least 1024 MiB");
  });

  it("never hardcodes memory in the resource", () => {
    expect(mainCode).toMatch(/memory\s*=\s*var\.task_memory/);
    expect(mainCode).not.toMatch(/memory\s*=\s*"512"/);
  });
});

describe("terraform aws-fargate — egress and ingress", () => {
  it("does not hardcode assign_public_ip = false", () => {
    // The flag must stay a variable: a private subnet with a NAT gateway is a
    // legitimate `false`, and a public subnet is a mandatory `true`. Hardcoding
    // either one is what produced CannotPullContainerError.
    expect(mainCode).toMatch(/assign_public_ip\s*=\s*var\.assign_public_ip/);
    expect(mainCode).not.toMatch(/assign_public_ip\s*=\s*false/);
  });

  it("defaults assign_public_ip to true", () => {
    expect(variables).toMatch(/variable "assign_public_ip"[\s\S]*?default\s*=\s*true/);
  });

  it("opens no inbound port to the task", () => {
    // The outbound-only invariant. The only ingress rule in the module is NFS
    // to the EFS mount targets, from the task's own security group.
    const ingressBlocks = mainCode.match(/ingress\s*\{[\s\S]*?\n  \}/g) ?? [];
    expect(ingressBlocks).toHaveLength(1);
    expect(ingressBlocks[0]).toContain("2049");
    expect(ingressBlocks[0]).toContain("var.security_group_id");
    // And nothing resembling a load balancer.
    expect(mainCode).not.toMatch(/aws_lb\b|load_balancer/);
  });
});

describe("terraform aws-fargate — the state volume is the connector's identity", () => {
  it("backs state with EFS, not an ephemeral task volume", () => {
    expect(mainCode).toContain("aws_efs_file_system");
    expect(mainCode).toMatch(/efs_volume_configuration\s*\{/);
    // A bare `volume { name = "state" }` with no efs block is the regression.
    const stateVolume = /volume\s*\{\s*\n\s*name\s*=\s*"state"([\s\S]*?)\n  \}/.exec(mainCode);
    expect(stateVolume, "no state volume block found").not.toBeNull();
    expect(stateVolume![1]).toContain("efs_volume_configuration");
  });

  it("pins the mount's POSIX identity to the image's uid", () => {
    // Without an access point the mount lands root-owned and the connector,
    // running as mcp, cannot write its store. The Dockerfile's user is 1000.
    expect(mainCode).toContain("aws_efs_access_point");
    expect(mainCode).toMatch(/uid\s*=\s*1000/);
    expect(mainCode).toMatch(/gid\s*=\s*1000/);
  });

  it("creates a mount target per subnet", () => {
    // Missing one makes the mount fail only in that AZ — a flaky deploy.
    expect(mainCode).toMatch(/aws_efs_mount_target[\s\S]*?for_each\s*=\s*toset\(var\.subnet_ids\)/);
  });

  it("waits for the mount targets before starting tasks", () => {
    expect(mainCode).toMatch(/depends_on\s*=\s*\[aws_efs_mount_target\.state\]/);
  });

  it("mounts nothing at /etc/mcp-connector", () => {
    // The entrypoint WRITES the decoded master key there. A read-only or
    // shadowing mount breaks boot; the module used to mount an ephemeral
    // `config` volume over exactly that path.
    expect(mainCode).not.toContain('containerPath = "/etc/mcp-connector"');
    expect(mainCode).not.toMatch(/name\s*=\s*"config"/);
  });

  it("exports the filesystem id so it can be backed up", () => {
    expect(outputs).toContain("state_file_system_id");
  });
});

describe("terraform aws-fargate — single replica and operator access", () => {
  it("pins desired_count to 1", () => {
    // Identity binds (tenant, name) at register-frame time; a second task
    // collides on the controller's duplicate-name guard.
    expect(mainCode).toMatch(/desired_count\s*=\s*1\b/);
    expect(mainCode).not.toMatch(/desired_count\s*=\s*var\./);
  });

  it("enables ECS Exec, without which first-connect is impossible", () => {
    // Configure Tunnel is the ONLY way to set tunnel identity, and reaching it
    // needs a loopback origin. ECS Exec enters the task's namespace; nothing
    // else here does.
    expect(mainCode).toMatch(/enable_execute_command\s*=\s*true/);
  });

  it("health-checks /readyz on the health port, not the inspector", () => {
    // Stage A. This asserted 127.0.0.1:9090 — the inspector's "/", which only
    // proves the HTTP server answers and cannot distinguish a connector with no
    // controller from a healthy one. /readyz returns 503 until the tunnel is
    // open, so ECS now stops counting an unconfigured task healthy.
    expect(mainCode).toMatch(/healthCheck\s*=/);
    expect(mainCode).toContain("127.0.0.1:9100/readyz");
    expect(mainCode).toMatch(/name = "HEALTH_PORT", value = "9100"/);
    // The retired probe. Named so a revert is loud.
    expect(mainCode).not.toContain("127.0.0.1:9090/");
    // /readyz is 503 until Configure Tunnel — a human step on a first deploy.
    expect(mainCode).toMatch(/startPeriod = 9\d/);
  });
});

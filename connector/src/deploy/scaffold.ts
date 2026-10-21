// `tool-proxy deploy init --target <t>` — emits cloud-specific
// deployment manifests with the customer's CONNECTOR_NAME and
// CONTROLLER_URL substituted in. Replaces the copy-paste-and-edit cycle
// from deploy/**/*.md with one command.
//
// Naming note: this file is still named scaffold.ts because the internal
// concept — filling in a template + writing files to disk — is scaffolding.
// The CLI verb was renamed from `deploy scaffold` to `deploy init` because
// "scaffold" leaked internal jargon into operator-facing UX; the namespaced
// `deploy <subverb>` shape (matches git/kubectl/docker) reserves room for
// a future `deploy apply` companion that actually applies to the cloud.
// Under the hood this is still a scaffold; the CLI just calls it clearer.
//
// Split into two entry points:
//   scaffoldTo(target, vars, outDir)  — pure(-ish): renders + writes files
//   runDeployInit(argv)               — CLI wrapper: parses argv, prompts
//                                       for missing values, calls scaffoldTo
//
// The pure entry lets tests write to a tmpdir and assert file presence /
// content without touching stdin.

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { render, type ScaffoldTarget, type ScaffoldVars } from "./templates.js";

const TARGETS: ScaffoldTarget[] = ["fargate", "aca", "compose", "fly", "fly-mock"];

// Targets that existed and no longer do, with what to use instead. Keep an
// entry here rather than deleting it outright — the value of removing a broken
// target is lost if the operator just gets "unknown target".
const RETIRED_TARGETS: Record<string, string> = {
  gke: `Kubernetes is served by the Helm chart, which does the same job correctly:

    helm install my-connector ./deploy/helm/tool-proxy \\
      --set image.tag=<version> \\
      --set secrets.connectorKeyB64="$(head -c 32 /dev/urandom | base64)"

If your policy forbids installing Helm releases, render raw manifests from the
same chart instead of hand-maintaining a second copy:

    helm template my-connector ./deploy/helm/tool-proxy \\
      --set image.tag=<version> --set secrets.connectorKeyB64=<base64> \\
      | kubectl apply -f -

See deploy/helm/tool-proxy/README.md.`,
};
const DEFAULT_OUT: Record<ScaffoldTarget, string> = {
  fargate: "./deploy/aws-fargate",
  aca: "./deploy/aca",
  compose: "./deploy/compose",
  // fly.toml lives alongside the other per-platform artifacts under
  // deploy/fly/ (parallel to deploy/helm/, deploy/terraform/, etc.).
  // Fly's build context is the CWD when `fly deploy` runs (repo root),
  // so `fly deploy -c deploy/fly/fly.toml` from repo root gets the full
  // repo as context and the Dockerfile path in fly.toml resolves
  // relative to CWD. `deploy apply --target fly` wires this up.
  fly: "./deploy/fly",
  // fly-mock output lives in-tree with the mock source it packages. The
  // mock's Dockerfile sits right next to its fly.toml, so the build
  // context is self-contained — no repo-root requirement.
  "fly-mock": "./examples/mock-backend",
};

export interface ScaffoldWriteResult {
  outDir: string;
  written: string[];
  readmeAppendix: string;
}

// Pure API: render + write. Tests inject a tmpdir as outDir.
export async function scaffoldTo(
  target: ScaffoldTarget,
  vars: ScaffoldVars,
  outDir: string,
  opts: { force?: boolean } = {},
): Promise<ScaffoldWriteResult> {
  const { files, readmeAppendix } = render(target, vars);
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const file of files) {
    const dest = join(outDir, file.path);
    if (!opts.force) {
      try {
        await access(dest, fsConstants.F_OK);
        throw new Error(`refusing to overwrite ${dest} (pass --force to overwrite)`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(resolvePath(dest, ".."), { recursive: true });
    await writeFile(dest, file.content);
    written.push(dest);
  }

  return { outDir, written, readmeAppendix };
}

// CLI entry.
const USAGE = `usage: tool-proxy deploy init --target <t> [flags]

Generates cloud-specific deployment manifests for the connector, with your name
and image reference substituted in. Does NOT touch the cloud — writes files
locally for you to apply with the cloud's native tool
(aws / az / docker compose / fly).

The manifests carry ONE secret: a 32-byte master key. Controller URL, connector
name and auth posture are entered in the inspector's Configure Tunnel modal once
the container is running, so nothing here asks for them.

Kubernetes has no target here — use the Helm chart at deploy/helm/tool-proxy/.

Targets:
  fargate    AWS Fargate task definition + Secrets Manager and EFS hints
  aca        Azure Container Apps bicep template
  compose    docker-compose.yml + .env.example (single-VM prod)
  fly        Fly.io fly.toml + secrets-hint.sh (connector, outbound-only)
  fly-mock   Fly.io fly.toml + Dockerfile for the demo mock backend (private,
             .internal-DNS-only, same Fly org as the connector)

Flags:
  --target <t>          required (one of the above)
  --name <n>            names the emitted resources (task family, log group,
                        Fly app). Prompts if omitted. Use the same value you
                        will type into Configure Tunnel, so an operator
                        debugging at 3am does not have to map one to the other
  --app-name <a>        Fly-only: the Fly.io app name. Defaults to
                        "tool-proxy-<name>" (fly) or "mock-customers-<name>"
                        (fly-mock). Set this if you want a custom, non-prefixed
                        name — e.g. "tool-proxy". Ignored for non-Fly targets.
  --image <ref>         OCI image ref (default ghcr.io/twilio/tool-proxy:latest)
  --controller-url <u>  IGNORED (accepted for compatibility; warns)
  --auth <a>            IGNORED (accepted for compatibility; warns)
  --out <dir>           output directory (default ./deploy/<target>)
  --yes                 non-interactive: use flag values only, no prompts
  --force               overwrite existing files
  -h, --help            show this help`;

export async function runDeployInit(argv: string[]): Promise<number> {
  const args = argv;

  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      name: { type: "string" },
      "app-name": { type: "string" },
      "controller-url": { type: "string" },
      image: { type: "string" },
      auth: { type: "string" },
      out: { type: "string" },
      yes: { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const target = values.target as ScaffoldTarget | undefined;
  if (!target) {
    process.stderr.write(`error: --target is required\n\n${USAGE}\n`);
    return 2;
  }
  if (!TARGETS.includes(target)) {
    // A retired target deserves its replacement, not just a list. Someone
    // typing `--target gke` is following a runbook we changed under them, and
    // the generic message would leave them guessing.
    const retired = RETIRED_TARGETS[target as string];
    if (retired) {
      process.stderr.write(`error: the \`${target}\` target was removed.\n\n${retired}\n`);
      return 2;
    }
    process.stderr.write(`error: unknown target "${target}" (want one of: ${TARGETS.join(", ")})\n`);
    return 2;
  }

  const nonInteractive = !!values.yes;
  const rl = nonInteractive ? null : createInterface({ input, output });
  try {
    // For fly-mock, --name is the DEMO slug (not the connector name); the
    // resulting app is mock-customers-<slug>. Same variable, different
    // semantics — flagged in the prompt text.
    const namePrompt =
      target === "fly-mock"
        ? "DEMO slug (used as mock-customers-<slug>; matches --name on the connector app)"
        : "CONNECTOR_NAME (must match your controller's Tunnel Security row Name exactly)";
    const name = await resolveField(rl, values.name, namePrompt, nonInteractive, "name");

    // No prompt for a controller URL or an auth posture. Nothing in any
    // template consumes them — CONTROLLER_URL was retired by ENV-TO-DB and the
    // posture is chosen in the inspector's Configure Tunnel modal — so asking
    // was bloat, and under --yes it was worse than bloat: resolveField THREW
    // when --controller-url was absent, so `deploy init --target fargate --yes`
    // failed on a value it would then have discarded.
    //
    // The flags are still ACCEPTED rather than rejected, because runbooks and
    // CI scripts pass them. A warning is the honest middle: nothing breaks, and
    // the operator learns the value is unused. (Contrast the Terraform module,
    // where the equivalent input was deleted outright — there the caller is
    // editing code and a loud error is the kinder signal.)
    for (const dead of ["controller-url", "auth"] as const) {
      if (values[dead]) {
        process.stderr.write(
          `warn: --${dead} is ignored and will be removed. Tunnel identity and ` +
          `auth posture are configured in the inspector's Configure Tunnel modal ` +
          `after the container is running, not baked into a manifest.\n`,
        );
      }
    }

    // Fly app name: `--app-name` wins; otherwise default from target
    // convention (`tool-proxy-<name>` / `mock-customers-<name>`).
    // Non-Fly targets ignore this field but it's harmless to compute.
    const appName = values["app-name"] ?? defaultAppName(target, name);

    const vars: ScaffoldVars = {
      name,
      appName,
      image: values.image ?? "ghcr.io/twilio/tool-proxy:latest",
    };

    const outDir = resolvePath(values.out ?? DEFAULT_OUT[target]);
    const result = await scaffoldTo(target, vars, outDir, { force: !!values.force });

    process.stdout.write(`\nWrote ${result.written.length} file(s) to ${outDir}:\n`);
    for (const p of result.written) process.stdout.write(`  ${p}\n`);
    process.stdout.write(`\n${result.readmeAppendix}\n`);
    return 0;
  } finally {
    rl?.close();
  }
}

// A field is either supplied by flag or prompted. Non-interactive mode
// (--yes) forbids prompting and errors on missing required fields.
async function resolveField(
  rl: ReturnType<typeof createInterface> | null,
  flagValue: string | undefined,
  prompt: string,
  nonInteractive: boolean,
  flagName: string,
): Promise<string> {
  if (flagValue) return flagValue;
  if (nonInteractive) {
    throw new Error(`--${flagName} is required in non-interactive mode (--yes)`);
  }
  const value = (await rl!.question(`${prompt}: `)).trim();
  if (!value) throw new Error(`${flagName} is required`);
  return value;
}


// Default Fly app name convention per target. Non-Fly targets return the
// bare `name` — they don't reference {{APP_NAME}} in their templates so the
// value is unused, but returning `name` keeps ScaffoldVars uniformly populated.
function defaultAppName(target: ScaffoldTarget, name: string): string {
  if (target === "fly") return `tool-proxy-${name}`;
  if (target === "fly-mock") return `mock-customers-${name}`;
  return name;
}

// `normalizeControllerUrl` lived here and is gone. It stripped a trailing
// "/mcp-tunnel" off a pasted controller URL — a real foot-gun, but one this CLI
// no longer touches, since it does not take a controller URL. The live copy is
// inspector/tunnel-routes.ts's, reached by the Configure Tunnel modal that now
// owns the paste, and it is the better one: it also handles "/mcp-tunnel/tunnel",
// is case-insensitive, and is idempotent. Pinned by
// tests/inspector/tunnel-routes.test.ts.

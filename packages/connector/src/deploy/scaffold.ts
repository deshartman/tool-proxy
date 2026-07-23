// `mcp-connector deploy init --target <t>` — emits cloud-specific
// deployment manifests with the customer's CONNECTOR_NAME and
// CONTROLLER_URL substituted in. Replaces the copy-paste-and-edit cycle
// from docs/deploy/*.md with one command.
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
import { render, targetNeedsControllerUrl, type ScaffoldTarget, type ScaffoldVars } from "./templates.js";

const TARGETS: ScaffoldTarget[] = ["fargate", "gke", "aca", "compose", "fly", "fly-mock"];
const DEFAULT_OUT: Record<ScaffoldTarget, string> = {
  fargate: "./deploy/aws-fargate",
  gke: "./deploy/gke",
  aca: "./deploy/aca",
  compose: "./deploy/compose",
  // Fly's build context is locked to the fly.toml's directory (no
  // --build-context flag exists), and our Dockerfile COPYs package.json,
  // packages/connector/, mcp/, bundles/ — all at repo root. So fly.toml
  // MUST live at repo root or the build fails with "Dockerfile not found"
  // / missing source files. See architectural-plans/CODE-DEPLOY.md §B1.
  fly: ".",
  // fly-mock output lives in-tree with the mock source it packages. The
  // mock's Dockerfile sits right next to its fly.toml, so the build
  // context is self-contained — no repo-root requirement.
  "fly-mock": "./mock/customers",
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
const USAGE = `usage: mcp-connector deploy init --target <t> [flags]

Generates cloud-specific deployment manifests for the connector, with your
CONNECTOR_NAME and CONTROLLER_URL substituted in. Does NOT touch the cloud —
writes files locally for you to apply with the cloud's native tool
(aws / kubectl / az / docker compose / fly).

Targets:
  fargate    AWS Fargate task definition + Secrets Manager hint
  gke        Kubernetes manifests (Namespace, Secret, ConfigMap, Deployment, PVC)
  aca        Azure Container Apps bicep template
  compose    docker-compose.yml + .env.example (single-VM prod)
  fly        Fly.io fly.toml + secrets-hint.sh (connector, outbound-only)
  fly-mock   Fly.io fly.toml + Dockerfile for the demo mock backend (private,
             .internal-DNS-only, same Fly org as the connector)

Flags:
  --target <t>          required (one of the above)
  --name <n>            CONNECTOR_NAME (prompts if omitted); the identity
                        the connector presents to the controller
  --app-name <a>        Fly-only: the Fly.io app name. Defaults to
                        "mcp-connector-<name>" (fly) or "mock-customers-<name>"
                        (fly-mock). Set this if you want a custom, non-prefixed
                        name — e.g. "twilio-tool-sdk". Ignored for non-Fly targets.
  --controller-url <u>  CONTROLLER_URL (prompts if omitted)
  --image <ref>         OCI image ref (default ghcr.io/twilio/mcp-connector:latest)
  --creds-source <s>    "db" (default) or "env"
  --auth <a>            "static" (default) or "oauth2"
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
      "creds-source": { type: "string" },
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

    // The mock backend doesn't dial anywhere — no controller URL needed.
    const controllerUrl = targetNeedsControllerUrl(target)
      ? await resolveField(
          rl,
          values["controller-url"],
          "CONTROLLER_URL (https://...)",
          nonInteractive,
          "controller-url",
        )
      : (values["controller-url"] ?? "");

    // Fly app name: `--app-name` wins; otherwise default from target
    // convention (`mcp-connector-<name>` / `mock-customers-<name>`).
    // Non-Fly targets ignore this field but it's harmless to compute.
    const appName = values["app-name"] ?? defaultAppName(target, name);

    const vars: ScaffoldVars = {
      name,
      appName,
      controllerUrl,
      image: values.image ?? "ghcr.io/twilio/mcp-connector:latest",
      credsSource: parseEnum(values["creds-source"], ["db", "env"], "db"),
      auth: parseEnum(values.auth, ["static", "oauth2"], "static"),
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

function parseEnum<T extends string>(raw: string | undefined, values: readonly T[], fallback: T): T {
  if (!raw) return fallback;
  if (!(values as readonly string[]).includes(raw)) {
    throw new Error(`invalid value "${raw}" (want one of: ${values.join(", ")})`);
  }
  return raw as T;
}

// Default Fly app name convention per target. Non-Fly targets return the
// bare `name` — they don't reference {{APP_NAME}} in their templates so the
// value is unused, but returning `name` keeps ScaffoldVars uniformly populated.
function defaultAppName(target: ScaffoldTarget, name: string): string {
  if (target === "fly") return `mcp-connector-${name}`;
  if (target === "fly-mock") return `mock-customers-${name}`;
  return name;
}

// `mcp-connector deploy scaffold --target <t>` — emits cloud-specific
// deployment manifests with the customer's CONNECTOR_NAME and
// CONTROLLER_URL substituted in. Replaces the copy-paste-and-edit cycle
// from docs/deploy/*.md with one command.
//
// Split into two entry points:
//   scaffoldTo(target, vars, outDir)  — pure(-ish): renders + writes files
//   runScaffold(argv)                 — CLI wrapper: parses argv, prompts
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

const TARGETS: ScaffoldTarget[] = ["fargate", "gke", "aca", "compose"];
const DEFAULT_OUT: Record<ScaffoldTarget, string> = {
  fargate: "./deploy/aws-fargate",
  gke: "./deploy/gke",
  aca: "./deploy/aca",
  compose: "./deploy/compose",
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
const USAGE = `usage: mcp-connector deploy scaffold --target <t> [flags]

Emits cloud-specific deployment manifests for the connector, with your
CONNECTOR_NAME and CONTROLLER_URL substituted in.

Targets:
  fargate    AWS Fargate task definition + Secrets Manager hint
  gke        Kubernetes manifests (Namespace, Secret, ConfigMap, Deployment, PVC)
  aca        Azure Container Apps bicep template
  compose    docker-compose.yml + .env.example (single-VM prod)

Flags:
  --target <t>          required (one of the above)
  --name <n>            CONNECTOR_NAME (prompts if omitted)
  --controller-url <u>  CONTROLLER_URL (prompts if omitted)
  --image <ref>         OCI image ref (default ghcr.io/twilio/mcp-connector:latest)
  --creds-source <s>    "db" (default) or "env"
  --auth <a>            "static" (default) or "oauth2"
  --out <dir>           output directory (default ./deploy/<target>)
  --yes                 non-interactive: use flag values only, no prompts
  --force               overwrite existing files
  -h, --help            show this help`;

export async function runScaffold(argv: string[]): Promise<number> {
  // Two verbs today: `deploy scaffold` (this) and — in future — other
  // deploy-time verbs. Strip the "scaffold" subverb if present.
  const args = argv[0] === "scaffold" ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      name: { type: "string" },
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
    const name = await resolveField(
      rl,
      values.name,
      "CONNECTOR_NAME (must match your controller's Tunnel Security row Name exactly)",
      nonInteractive,
      "name",
    );
    const controllerUrl = await resolveField(
      rl,
      values["controller-url"],
      "CONTROLLER_URL (https://...)",
      nonInteractive,
      "controller-url",
    );

    const vars: ScaffoldVars = {
      name,
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

import "dotenv/config";
import { parseArgs } from "node:util";
import { boot } from "./boot/lifecycle.js";
import { runDiscover } from "./discover.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runDeployInit } from "./deploy/scaffold.js";
import { runDeployApply } from "./deploy/apply.js";
import { createLogger } from "./logger.js";
import { envString } from "./env.js";

const log = createLogger("connector");

const USAGE = `usage: mcp-connector <command> [options]

commands:
  start                   run the connector (default). Auto-registers with the controller on first connect.
  init                    interactive wizard to write connector.yaml
  discover                connect to MCP servers and print tools/list
  doctor                  run preflight checks against your .env and connector.yaml
  deploy init             generate cloud deployment manifests (fargate/gke/aca/compose/fly).
                          Does NOT touch the cloud — writes files for the operator to apply.
  deploy apply            actually deploy to the cloud (fly today; other targets forthcoming).
  version                 print the connector version

start options:
  --config <path>         override CONNECTOR_CONFIG
  --inspector-port <n>    override INSPECTOR_PORT (0 disables)
  --no-inspector          shorthand for --inspector-port 0
  -h, --help              show this help`;

async function dispatch(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
  const rest = command === argv[0] ? argv.slice(1) : argv;

  switch (command) {
    case "start":
      applyStartFlags(rest);
      await boot();
      return;
    case "version":
      console.log(envString("CONNECTOR_VERSION", "dev"));
      return;
    case "discover":
      await runDiscover(rest);
      return;
    case "init":
      await runInit(rest);
      return;
    case "doctor": {
      const code = await runDoctor(rest);
      process.exit(code);
    }
    case "deploy": {
      // Namespaced sub-verbs — matches git/kubectl/docker conventions where
      // related actions cluster under one top-level command. Today: `init`
      // (scaffold config files). Reserved: `apply` (actually deploy).
      const subverb = rest[0];
      const subrest = rest.slice(1);
      if (!subverb || subverb === "-h" || subverb === "--help") {
        console.log(
          `usage: mcp-connector deploy <subcommand> [options]\n\n` +
          `subcommands:\n` +
          `  init    generate cloud deployment manifests (does NOT touch the cloud)\n` +
          `  apply   actually deploy to the cloud using config from a prior init\n\n` +
          `Run \`mcp-connector deploy init --help\` or \`deploy apply --help\` for flags.`,
        );
        process.exit(subverb ? 0 : 2);
      }
      switch (subverb) {
        case "init": {
          const code = await runDeployInit(subrest);
          process.exit(code);
        }
        case "apply": {
          const code = await runDeployApply(subrest);
          process.exit(code);
        }
        default: {
          console.error(
            `unknown deploy sub-command: ${subverb}. Try: init, apply\n\n${USAGE}`,
          );
          process.exit(2);
        }
      }
    }
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

function applyStartFlags(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "inspector-port": { type: "string" },
      "no-inspector": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (values.config) process.env.CONNECTOR_CONFIG = values.config;
  if (values["no-inspector"]) process.env.INSPECTOR_PORT = "0";
  if (values["inspector-port"]) process.env.INSPECTOR_PORT = values["inspector-port"];
}

dispatch().catch((error) => {
  log.fatal({ err: error as Error }, `connector startup failed`);
  process.exit(1);
});

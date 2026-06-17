import "dotenv/config";
import { parseArgs } from "node:util";
import { boot } from "./boot/lifecycle.js";
import { runDiscover } from "./discover.js";
import { runInit } from "./init.js";
import { createLogger } from "./logger.js";

const log = createLogger("connector");

const USAGE = `usage: mcp-connector <command> [options]

commands:
  start                   run the connector (default). Auto-registers with the controller on first connect.
  init                    interactive wizard to write connector.yaml
  discover                connect to MCP servers and print tools/list
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
      console.log(process.env.CONNECTOR_VERSION ?? "dev");
      return;
    case "discover":
      await runDiscover(rest);
      return;
    case "init":
      await runInit(rest);
      return;
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

dispatch().catch((e) => {
  log.fatal({ err: e as Error }, `connector startup failed`);
  process.exit(1);
});

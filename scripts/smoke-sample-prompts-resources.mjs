// One-shot smoke check: spawn the sample MCP via tsx, connect a real MCP
// Client, list tools/prompts/resources, fetch the prompt + read the
// resource. Prints everything to stdout and exits 0 on success.
//
// This intentionally re-uses the customer-facing path: tsx +
// streamable-http transport + /mcp endpoint, just like the connector's
// supervisor would.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(here, "..", "examples", "demos", "sample");
const tsxBin = resolve(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

const port = "7901";
const child = spawn(process.execPath, [tsxBin, "server.ts"], {
  cwd: sampleDir,
  env: { ...process.env, PORT: port },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`[sample] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[sample!] ${d}`));

const ready = new Promise((res, rej) => {
  child.stdout.on("data", (d) => {
    if (String(d).includes("listening")) res();
  });
  setTimeout(() => rej(new Error("sample did not log 'listening' within 8s")), 8000);
});
await ready;

const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
await client.connect(transport);

const tools = await client.listTools();
console.log("\n== tools ==");
for (const t of tools.tools) console.log(`  - ${t.name}: ${t.description ?? ""}`);

const prompts = await client.listPrompts();
console.log("\n== prompts ==");
for (const p of prompts.prompts) console.log(`  - ${p.name}: ${p.description ?? ""}`);

const resources = await client.listResources();
console.log("\n== resources ==");
for (const r of resources.resources) console.log(`  - ${r.uri} (${r.name}, ${r.mimeType ?? "?"})`);

console.log("\n== prompts/get weather_briefing ==");
const got = await client.getPrompt({ name: "weather_briefing", arguments: { location: "Boulder, CO" } });
console.log(JSON.stringify(got, null, 2));

console.log("\n== resources/read sample://uuids/recent (after a uuid mint) ==");
await client.callTool({ name: "uuid", arguments: {} });
await client.callTool({ name: "uuid", arguments: {} });
const read = await client.readResource({ uri: "sample://uuids/recent" });
console.log(JSON.stringify(read, null, 2));

await client.close();
child.kill("SIGTERM");
console.log("\nsmoke OK");

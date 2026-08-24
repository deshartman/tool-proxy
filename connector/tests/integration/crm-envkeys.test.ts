import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpHttpServer } from "../../src/sdk/http-server.js";
import type { Tool } from "../../src/sdk/tool.js";

// MCP-AUDIT #20 / #28 / #21 — the crm drop-in's mock-backend endpoint.
//
// #20: eight of crm's nine tools read MOCK_CUSTOMERS_URL and none declared it in
// `envKeys`, so the MCP's /envkeys returned [] and the creds-request frame told
// the controller this MCP needs nothing. The controller could therefore NEVER
// supply the value — it worked only because deploy/templates.ts sets it as a
// connector-level Fly secret, which arrives through mergeEnv's process.env layer
// (the layer CLAUDE.md wants trending toward empty) and is visible to every
// child rather than just crm's.
//
// #28: the constant was duplicated verbatim in all eight files; it now lives in
// lib/backend.ts, which is what gives the #20 declaration one thing to point at.
//
// #21: that shared read uses envString, so MOCK_CUSTOMERS_URL="" falls back to
// the default instead of handing fetch() a bare path.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRM = resolve(__dirname, "../../..", "examples/demos/crm");

// The eight tools that reach the mock. notify-agent is the ninth and reaches
// nothing, so it must NOT declare the key — envKeys describes what the tool
// needs, and over-declaring would make the controller prompt for a credential
// the tool never reads.
const BACKEND_TOOLS = [
  "check-availability", "create-appointment", "create-customer",
  "get-appointment", "get-customer", "get-recent",
  "issue-refund", "update-appointment",
];
const NO_BACKEND_TOOLS = ["notify-agent"];

async function loadTool(file: string): Promise<Tool> {
  const mod = await import(`${CRM}/tools/${file}.ts`);
  const tool = (mod.default ?? Object.values(mod).find(
    (v) => typeof v === "object" && v !== null && "register" in (v as object),
  )) as Tool | undefined;
  if (!tool) throw new Error(`${file} exports no Tool`);
  return tool;
}

let backend: Tool[] = [];
let noBackend: Tool[] = [];

beforeAll(async () => {
  backend = await Promise.all(BACKEND_TOOLS.map(loadTool));
  noBackend = await Promise.all(NO_BACKEND_TOOLS.map(loadTool));
});

describe("crm envKeys declaration (MCP-AUDIT #20)", () => {
  it("declares MOCK_CUSTOMERS_URL on every tool that reaches the backend", () => {
    for (const [i, tool] of backend.entries()) {
      expect(tool.envKeys, `${BACKEND_TOOLS[i]} must declare its env dependency`)
        .toEqual(["MOCK_CUSTOMERS_URL"]);
    }
  });

  it("does not declare it on the tool that reaches nothing", () => {
    for (const [i, tool] of noBackend.entries()) {
      expect(tool.envKeys, `${NO_BACKEND_TOOLS[i]} reads no env`).toBeUndefined();
    }
  });

  // The assertion that actually matters: this is the response the supervisor's
  // fetchEnvKeys() reads post-spawn to build the creds-request frame. Before the
  // fix it was `{ envKeys: [] }`, which is the whole bug — the controller had no
  // way to learn the key existed.
  it("surfaces the key on /envkeys, so creds-request names it", async () => {
    const handle = await createMcpHttpServer({
      name: "crm-envkeys-test",
      tools: [...backend, ...noBackend],
      port: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/envkeys`);
      expect(res.ok).toBe(true);
      // De-duped across all nine tools — one key, not eight copies.
      expect(await res.json()).toEqual({ envKeys: ["MOCK_CUSTOMERS_URL"] });
    } finally {
      await handle.close();
    }
  });
});

describe("crm backend constant (MCP-AUDIT #28)", () => {
  it("no tool re-declares MOCK_URL or reads process.env directly", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(join(CRM, "tools"))) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(join(CRM, "tools", file), "utf8")
        .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
      if (/const MOCK_URL\s*=/.test(src)) offenders.push(`${file}: re-declares MOCK_URL`);
      if (/process\.env/.test(src)) offenders.push(`${file}: reads process.env`);
    }
    expect(offenders).toEqual([]);
  });

  it("exports one MOCK_URL and one REQ_TIMEOUT_MS", async () => {
    const mod = await import(`${CRM}/lib/backend.ts`);
    expect(mod.MOCK_URL).toBe("http://localhost:7400");
    expect(mod.REQ_TIMEOUT_MS).toBe(4000);
  });

  it("reads the endpoint through envString, not `??` (MCP-AUDIT #21)", () => {
    const src = readFileSync(join(CRM, "lib", "backend.ts"), "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(src).toMatch(/envString\("MOCK_CUSTOMERS_URL"/);
    // `??` here would let MOCK_CUSTOMERS_URL="" through as an empty base URL,
    // and every fetch in the bundle would throw "Failed to parse URL".
    expect(src).not.toMatch(/process\.env\.MOCK_CUSTOMERS_URL\s*\?\?/);
  });
});

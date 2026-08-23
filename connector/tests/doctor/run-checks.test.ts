import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

import { runChecks } from "../../src/doctor.js";

// runChecks is a pure(-ish) function: it reads env, filesystem, and (when
// not skipNetwork) TCP. Every assertion in this file injects env as a
// literal map and writes fixtures to a per-test tmpdir. No process.env
// mutation, no vi.stubEnv.

function makeFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mcp-doctor-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Bare-minimum yaml a doctor run can load without touching the network.
// mcp_servers requires >=1 entry per the ConfigSchema; the http endpoint
// here is a stand-in and never dialed (loadConfig only parses, doesn't
// connect).
const MIN_YAML = `mcp_servers:
  - name: placeholder
    transport: http
    endpoint: http://127.0.0.1:9999/mcp
policy:
  tool_timeout_ms: 5000
`;

function seedYaml(root: string): string {
  const path = join(root, "connector.yaml");
  writeFileSync(path, MIN_YAML);
  return path;
}

function seedEnvFile(root: string): void {
  writeFileSync(join(root, ".env"), "# doctor fixture\n");
}

// Pick an ephemeral free port and release it before returning. Small
// TOCTOU window but adequate for local dev / CI machines where the
// suite runs single-tenant. Beats hard-coding 9090 (the actual dev
// inspector often occupies that port on this machine).
async function pickFreePort(): Promise<number> {
  const server = await new Promise<Server>((resolveP) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => resolveP(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("no server address");
  }
  const { port } = addr;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("runChecks — db mode (only mode)", () => {
  it("fails when CONNECTOR_KEY_FILE is missing", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "db",
          POSTGRES_URL: "postgres://localhost:5432/mcp",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
        },
        { skipNetwork: true, cwd: root },
      );

      const key = results.find((r) => r.name === "connector-key-file");
      expect(key?.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  it("fails when key file is wrong size", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const badKey = join(root, "bad.key");
      writeFileSync(badKey, Buffer.alloc(16));

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "db",
          POSTGRES_URL: "postgres://localhost:5432/mcp",
          CONNECTOR_KEY_FILE: badKey,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
        },
        { skipNetwork: true, cwd: root },
      );

      const key = results.find((r) => r.name === "connector-key-file");
      expect(key?.status).toBe("fail");
      expect(key?.message).toMatch(/16 bytes/);
    } finally {
      cleanup();
    }
  });

  it("green when key file is 32 bytes", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const keyPath = join(root, "good.key");
      writeFileSync(keyPath, Buffer.alloc(32));

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "db",
          POSTGRES_URL: "postgres://localhost:5432/mcp",
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
        },
        { skipNetwork: true, cwd: root },
      );

      const key = results.find((r) => r.name === "connector-key-file");
      expect(key?.status).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("fails when POSTGRES_URL is missing", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const keyPath = join(root, "good.key");
      writeFileSync(keyPath, Buffer.alloc(32));

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "db",
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
        },
        { skipNetwork: true, cwd: root },
      );

      const pg = results.find((r) => r.name === "postgres-url");
      expect(pg?.status).toBe("fail");
      expect(pg?.message).toMatch(/required/);
    } finally {
      cleanup();
    }
  });
});

describe("runChecks — common", () => {
  it("warns when .env is missing but continues", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedYaml(root); // no .env
      const keyPath = join(root, "connector.key");
      writeFileSync(keyPath, Buffer.alloc(32));

      const results = await runChecks(
        {
          POSTGRES_URL: "postgres://user:pw@localhost:5432/mcp",
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
        },
        { skipNetwork: true, cwd: root },
      );

      const env = results.find((r) => r.name === "env-file");
      expect(env?.status).toBe("warn");
      // Rest of the checks still ran — the run didn't short-circuit.
      expect(results.length).toBeGreaterThan(2);
      expect(results.find((r) => r.name === "connector-yaml")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("fails when connector.yaml is unparseable", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      writeFileSync(join(root, "connector.yaml"), ": not valid yaml : {");

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "env",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          CONTROLLER_URL: "https://controller.example.com",
          CONNECTOR_NAME: "test",
          TUNNEL_AUTH_TOKEN: "ts_test",
        },
        { skipNetwork: true, cwd: root },
      );

      const yaml = results.find((r) => r.name === "connector-yaml");
      expect(yaml?.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  it("fails when inspector port is invalid", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "env",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          INSPECTOR_PORT: "not-a-number",
          CONTROLLER_URL: "https://controller.example.com",
          CONNECTOR_NAME: "test",
          TUNNEL_AUTH_TOKEN: "ts_test",
        },
        { skipNetwork: true, cwd: root },
      );

      const port = results.find((r) => r.name === "inspector-port");
      expect(port?.status).toBe("fail");
    } finally {
      cleanup();
    }
  });

  it("warns when inspector port is 0 (disabled)", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "env",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          INSPECTOR_PORT: "0",
          CONTROLLER_URL: "https://controller.example.com",
          CONNECTOR_NAME: "test",
          TUNNEL_AUTH_TOKEN: "ts_test",
        },
        { skipNetwork: true, cwd: root },
      );

      const port = results.find((r) => r.name === "inspector-port");
      expect(port?.status).toBe("warn");
      expect(port?.message).toMatch(/webhook/);
    } finally {
      cleanup();
    }
  });

  it("fails when inspector port is already in use", async () => {
    const { root, cleanup } = makeFixture();
    let server: Server | undefined;
    try {
      seedEnvFile(root);
      seedYaml(root);
      // Bind an ephemeral port ourselves, then feed it to doctor. This
      // proves the port-in-use branch without hard-coding a number.
      server = await new Promise<Server>((resolveP) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => resolveP(s));
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no server address");

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "env",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          INSPECTOR_PORT: String(addr.port),
          CONTROLLER_URL: "https://controller.example.com",
          CONNECTOR_NAME: "test",
          TUNNEL_AUTH_TOKEN: "ts_test",
        },
        { skipNetwork: true, cwd: root },
      );

      const port = results.find((r) => r.name === "inspector-port");
      expect(port?.status).toBe("fail");
      expect(port?.message).toMatch(/in use/);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      cleanup();
    }
  });

  it("recognizes an MCP dropin directory", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      mkdirSync(join(root, "customer-mcps"), { recursive: true });

      const results = await runChecks(
        {
          CONNECTOR_CREDS_SOURCE: "env",
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          CONTROLLER_URL: "https://controller.example.com",
          CONNECTOR_NAME: "test",
          TUNNEL_AUTH_TOKEN: "ts_test",
        },
        { skipNetwork: true, cwd: root },
      );

      const tree = results.find((r) => r.name === "mcp-tree");
      expect(tree?.status).toBe("ok");
    } finally {
      cleanup();
    }
  });
});


// Regression: checkMcpTree probed ./mcp/local and ./mcp/bundled, paths that
// stopped existing at the customer-repo carve-out. A tree full of working
// MCPs therefore reported "no MCP drop-in directory found", and the
// remediation pointed developers at a directory that no longer exists.
describe("runChecks — mcp-tree probes the paths the scanner actually reads", () => {
  it("finds ./customer-mcps and ./bundled-mcps by default", async () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFileSync(join(root, "connector.yaml"), MIN_YAML);
      mkdirSync(join(root, "customer-mcps"));
      mkdirSync(join(root, "bundled-mcps"));

      const results = await runChecks(
        { CONNECTOR_CONFIG: join(root, "connector.yaml") },
        { skipNetwork: true, cwd: root },
      );
      const tree = results.find((r) => r.name === "mcp-tree");
      expect(tree?.status).toBe("ok");
      expect(tree?.message).toContain(join(root, "customer-mcps"));
      expect(tree?.message).toContain(join(root, "bundled-mcps"));
    } finally {
      cleanup();
    }
  });

  it("honours MCP_DROPIN_DIR / MCP_BUNDLED_DIR over the cwd defaults", async () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFileSync(join(root, "connector.yaml"), MIN_YAML);
      const dropin = join(root, "elsewhere-dropin");
      const bundled = join(root, "elsewhere-bundled");
      mkdirSync(dropin);
      mkdirSync(bundled);
      // The cwd defaults exist too, so a passing assertion proves the env
      // vars were consulted rather than coincidentally matching.
      mkdirSync(join(root, "customer-mcps"));

      const results = await runChecks(
        {
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          MCP_DROPIN_DIR: dropin,
          MCP_BUNDLED_DIR: bundled,
        },
        { skipNetwork: true, cwd: root },
      );
      const tree = results.find((r) => r.name === "mcp-tree");
      expect(tree?.status).toBe("ok");
      expect(tree?.message).toContain(dropin);
      expect(tree?.message).toContain(bundled);
      expect(tree?.message).not.toContain(join(root, "customer-mcps"));
    } finally {
      cleanup();
    }
  });

  it("still warns when no drop-in directory exists at all (Type 2-only deployment)", async () => {
    const { root, cleanup } = makeFixture();
    try {
      writeFileSync(join(root, "connector.yaml"), MIN_YAML);
      const results = await runChecks(
        { CONNECTOR_CONFIG: join(root, "connector.yaml") },
        { skipNetwork: true, cwd: root },
      );
      const tree = results.find((r) => r.name === "mcp-tree");
      expect(tree?.status).toBe("warn");
      // Remediation must name a path that exists in this layout.
      expect(tree?.remediation).toContain("customer-mcps");
      expect(tree?.remediation).not.toContain("mcp/local");
    } finally {
      cleanup();
    }
  });
});

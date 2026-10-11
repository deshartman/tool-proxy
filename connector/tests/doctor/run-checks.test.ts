import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer, type Server, type Socket } from "node:net";
import { createServer, type AddressInfo } from "node:http";

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
    const s = netCreateServer();
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

  // The config store lives on the state volume, so the failure doctor must
  // pre-empt is "this uid cannot write there" — which otherwise surfaces on the
  // operator's FIRST Configure Tunnel submit, long after the deploy looked
  // healthy. That lazy-write shape is the agentic-memory EACCES bug; these two
  // cases keep it caught early.
  it("passes when the state dir is writable and the store is absent", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const keyPath = join(root, "good.key");
      writeFileSync(keyPath, Buffer.alloc(32));
      const stateDir = join(root, "state");
      mkdirSync(stateDir);

      const results = await runChecks(
        {
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          CONNECTOR_STATE_DIR: stateDir,
        },
        { cwd: root },
      );

      const store = results.find((r) => r.name === "config-store");
      expect(store?.status).toBe("ok");
      expect(store?.message).toMatch(/will be created at boot/);
    } finally {
      cleanup();
    }
  });

  it("fails when the state dir is not writable", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const keyPath = join(root, "good.key");
      writeFileSync(keyPath, Buffer.alloc(32));
      const stateDir = join(root, "readonly");
      mkdirSync(stateDir);
      chmodSync(stateDir, 0o500); // r-x: readable, NOT writable

      const results = await runChecks(
        {
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          CONNECTOR_STATE_DIR: stateDir,
        },
        { cwd: root },
      );

      const store = results.find((r) => r.name === "config-store");
      expect(store?.status).toBe("fail");
      expect(store?.message).toMatch(/not writable/);

      chmodSync(stateDir, 0o700); // so cleanup can remove it
    } finally {
      cleanup();
    }
  });

  it("fails when the store was sealed with a different master key", async () => {
    const { root, cleanup } = makeFixture();
    try {
      seedEnvFile(root);
      seedYaml(root);
      const keyPath = join(root, "good.key");
      writeFileSync(keyPath, Buffer.alloc(32));
      chmodSync(keyPath, 0o600); // resolveMasterKey refuses group/other-readable keys
      const stateDir = join(root, "state");
      mkdirSync(stateDir);
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({
          version: 1,
          keyFingerprint: "0".repeat(64), // not the fingerprint of a 32-zero-byte key
          controllers: [],
          networkAccess: { enabled: false },
          trustedIssuer: null,
          apiClients: [],
        }),
      );

      const results = await runChecks(
        {
          CONNECTOR_KEY_FILE: keyPath,
          CONNECTOR_CONFIG: join(root, "connector.yaml"),
          CONNECTOR_STATE_DIR: stateDir,
        },
        { cwd: root },
      );

      const store = results.find((r) => r.name === "config-store");
      expect(store?.status).toBe("fail");
      expect(store?.message).toMatch(/different master key/);
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
    const openSockets = new Set<Socket>();
    try {
      seedEnvFile(root);
      seedYaml(root);
      // Bind an ephemeral port ourselves, then feed it to doctor. This
      // proves the port-in-use branch without hard-coding a number.
      // Raw TCP, deliberately: a listener that speaks no HTTP is the genuine
      // conflict this branch reports. An HTTP server would now be probed for
      // identity and could come back as "our own inspector".
      //
      // Sockets are tracked so cleanup can destroy them. The inspector-port
      // check probes the holder over HTTP; this listener accepts and never
      // replies, so the socket is still open when the probe aborts and
      // `close()` would wait for it forever. net.Server has no
      // closeAllConnections (that is http.Server), hence the manual set.
      // Verified in isolation: tracked + destroyed, close() returns in 0ms.
      server = await new Promise<Server>((resolveP) => {
        const s = netCreateServer((sock) => {
          openSockets.add(sock);
          sock.on("close", () => openSockets.delete(sock));
        });
        s.listen(0, "127.0.0.1", () => resolveP(s));
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no server address");

      const results = await runChecks(
        {
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
      if (server) {
        for (const sock of openSockets) sock.destroy();
        await new Promise<void>((r) => server!.close(() => r()));
      }
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

// The inspector-port check was written for the `doctor && start` runbook, where
// anything on the port is a real conflict. But `doctor` is also run against a
// RUNNING container to answer "is my deployment healthy?" — and there the holder
// is the connector being checked. A plain `fail` made every healthy deploy exit
// 1, which was the only non-ok line on the live AWS connector.
describe("inspector-port — self versus a genuine conflict", () => {
  it("reports ok when the port is serving our own inspector", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>MCP Connector Inspector</title></head></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const results = await runChecks({ INSPECTOR_PORT: String(port) }, { skipNetwork: false });
      const check = results.find((c) => c.name === "inspector-port")!;
      expect(check.status).toBe("ok");
      expect(check.message).toContain("already running");
    } finally {
      // http.Server DOES have closeAllConnections (net.Server does not). The
      // identity probe leaves a socket behind, so drop it before closing.
      server.closeAllConnections();
      server.close();
    }
  });

  it("reports ok on a 403 — the loopback gate refusing us is proof of identity", async () => {
    // Nothing else in this system answers 403 on `/`. Reached when doctor runs
    // from outside the container while the inspector is bound non-loopback.
    const server = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "forbidden: loopback only" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const results = await runChecks({ INSPECTOR_PORT: String(port) }, { skipNetwork: false });
      expect(results.find((c) => c.name === "inspector-port")!.status).toBe("ok");
    } finally {
      // http.Server DOES have closeAllConnections (net.Server does not). The
      // identity probe leaves a socket behind, so drop it before closing.
      server.closeAllConnections();
      server.close();
    }
  });

  it("still FAILS on an unrelated service — the conflict this check is for", async () => {
    // The generous version of this check would mask a real collision, which is
    // worse than the false FAIL it replaced.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><title>Some other app</title></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const results = await runChecks({ INSPECTOR_PORT: String(port) }, { skipNetwork: false });
      const check = results.find((c) => c.name === "inspector-port")!;
      expect(check.status).toBe("fail");
      expect(check.message).toContain("something else");
    } finally {
      // http.Server DOES have closeAllConnections (net.Server does not). The
      // identity probe leaves a socket behind, so drop it before closing.
      server.closeAllConnections();
      server.close();
    }
  });

  it("still FAILS on a raw TCP listener that speaks no HTTP", async () => {
    // Destroys on connect, so the probe gets a socket error rather than hanging
    // — and there is no lingering connection to clean up. net.Server has no
    // closeAllConnections, which is why this one differs from the three above.
    const server = netCreateServer((socket) => socket.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const results = await runChecks({ INSPECTOR_PORT: String(port) }, { skipNetwork: false });
      expect(results.find((c) => c.name === "inspector-port")!.status).toBe("fail");
    } finally {
      server.close();
    }
  });
});

// Several connectors on one host (D6). Every connector answers /livez the
// same way, so unlike inspector-port this check cannot tell "this connector"
// from "a sibling" — it reports a connector holder as a warn naming both
// readings. An unrelated holder of an EXPLICIT HEALTH_PORT is a fail, because
// boot exits on that (health/server.ts failOnBindError).
describe("health-port — multi-instance clash", () => {
  async function listen(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    return { server, port: (server.address() as AddressInfo).port };
  }
  function close(server: ReturnType<typeof createServer>) {
    server.closeAllConnections();
    server.close();
  }

  it("reports ok when the port is free", async () => {
    const { server, port } = await listen(() => undefined);
    close(server);
    await new Promise((r) => setImmediate(r));
    const results = await runChecks({ HEALTH_PORT: String(port) }, { skipNetwork: false });
    expect(results.find((c) => c.name === "health-port")!.status).toBe("ok");
  });

  it("warns when another connector's /livez answers on the port", async () => {
    const { server, port } = await listen((req, res) => {
      res.writeHead(req.url === "/livez" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const results = await runChecks({ HEALTH_PORT: String(port) }, { skipNetwork: false });
      const check = results.find((c) => c.name === "health-port")!;
      expect(check.status).toBe("warn");
      expect(check.remediation).toContain("own HEALTH_PORT");
    } finally {
      close(server);
    }
  });

  it("fails when an explicit HEALTH_PORT is held by something else", async () => {
    const { server, port } = await listen((_req, res) => { res.writeHead(404); res.end("nope"); });
    try {
      const results = await runChecks({ HEALTH_PORT: String(port) }, { skipNetwork: false });
      expect(results.find((c) => c.name === "health-port")!.status).toBe("fail");
    } finally {
      close(server);
    }
  });

  it("warns when HEALTH_PORT=0 disables the probes", async () => {
    const results = await runChecks({ HEALTH_PORT: "0" }, { skipNetwork: false });
    expect(results.find((c) => c.name === "health-port")!.status).toBe("warn");
  });
});

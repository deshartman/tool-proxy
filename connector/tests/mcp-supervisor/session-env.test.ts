import { describe, it, expect } from "vitest";

import { McpSupervisor } from "@connector/mcp-supervisor.js";
import { createLogger } from "@connector/logger.js";
import type { McpServerConnection } from "@connector/servers/index.js";
import type { McpServerSpec } from "@connector/config.js";

// INSPECTOR-CREDS-VISIBILITY (W-S1 + W-S2 + W-S3) — supervisor session-env
// primitive. Exercises `applySessionEnv` / `clearSessionEnv` and the new
// `sessionEnv` merge layer. We deliberately do NOT call `startAll()` —
// those tests would require spawning real children. The applied-env state
// is observable through the public surface (`statusList()` /
// `applySessionEnv()` return shape) which is what the inspector route
// will consume.

const log = createLogger("supervisor-session-env-test");

function makeSupervisor(): McpSupervisor {
  const servers = new Map<string, McpServerConnection>();
  return new McpSupervisor({ log, servers });
}

// Spec for an http+dir Type 1 entry. `__dropin: true` would mark it as a
// drop-in; we leave it as a yaml-style http entry for status.source clarity.
function specHttp(name: string): McpServerSpec {
  return {
    name,
    transport: "http",
    dir: "/tmp/no-such-dir",
  } as McpServerSpec;
}

describe("supervisor session-env primitive", () => {
  it("applySessionEnv on a registered-but-not-spawned entry buffers values + sets expiresAt", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("alpha")]);

    const result = await sup.applySessionEnv("alpha", { FOO: "from-session" });

    expect(result.applied).toBe(true);
    expect(result.restarted).toBe(false); // no child yet
    expect(result.expiresAt).toBeTypeOf("number");
    expect(result.expiresAt!).toBeGreaterThan(Date.now());

    const status = sup.statusList().find((s) => s.name === "alpha")!;
    expect(status.credsSource).toBe("session");
    expect(status.sessionCredsExpiresAt).toBe(result.expiresAt);
  });

  it("controller+session yields credsSource='controller+session' (Decision #1)", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("beta")]);

    await sup.applySessionEnv("beta", { FOO: "session-foo", BAR: "session-bar" });
    await sup.applyControllerEnv("beta", { FOO: "controller-foo" }, "operator-entered");

    const status = sup.statusList().find((s) => s.name === "beta")!;
    expect(status.credsSource).toBe("controller+session");
    expect(status.sessionCredsExpiresAt).toBeTypeOf("number");
  });

  it("controller alone yields credsSource='controller'", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("gamma")]);

    await sup.applyControllerEnv("gamma", { TOKEN: "from-ctrl" }, "operator-entered");

    const status = sup.statusList().find((s) => s.name === "gamma")!;
    expect(status.credsSource).toBe("controller");
    expect(status.sessionCredsExpiresAt).toBeUndefined();
  });

  it("clearSessionEnv removes the layer and restores prior credsSource", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("delta")]);

    await sup.applyControllerEnv("delta", { TOKEN: "ctrl" }, "operator-entered");
    await sup.applySessionEnv("delta", { LOCAL_KEY: "from-session" });
    expect(sup.statusList().find((s) => s.name === "delta")!.credsSource).toBe("controller+session");

    await sup.clearSessionEnv("delta");
    const after = sup.statusList().find((s) => s.name === "delta")!;
    expect(after.credsSource).toBe("controller");
    expect(after.sessionCredsExpiresAt).toBeUndefined();
  });

  it("TTL fires: applySessionEnv with ttlMs=20 triggers auto-clear (Decision #2)", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("epsilon")]);

    await sup.applySessionEnv("epsilon", { FOO: "session" }, { ttlMs: 20 });
    expect(sup.statusList().find((s) => s.name === "epsilon")!.credsSource).toBe("session");

    // Wait past the TTL, plus a tick for the auto-clear restart promise to settle.
    await new Promise((r) => setTimeout(r, 50));

    const after = sup.statusList().find((s) => s.name === "epsilon")!;
    expect(after.credsSource).toBe("none"); // dropped back to the prior label (no spec.env, no controller)
    expect(after.sessionCredsExpiresAt).toBeUndefined();
  });

  it("re-applying session creds resets the timer (no sliding-on-activity, but a re-paste IS a reset)", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("zeta")]);

    const first = await sup.applySessionEnv("zeta", { FOO: "v1" }, { ttlMs: 60_000 });
    // Sleep 5ms then re-apply — second call should produce a later expiresAt.
    await new Promise((r) => setTimeout(r, 5));
    const second = await sup.applySessionEnv("zeta", { FOO: "v2" }, { ttlMs: 60_000 });

    expect(second.expiresAt!).toBeGreaterThan(first.expiresAt!);
  });

  it("applySessionEnv with empty payload on an empty entry is a no-op", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("eta")]);

    const result = await sup.applySessionEnv("eta", {});
    expect(result.applied).toBe(true);
    expect(result.restarted).toBe(false);
    expect(result.expiresAt).toBeUndefined();

    const status = sup.statusList().find((s) => s.name === "eta")!;
    expect(status.credsSource).toBe("none");
    expect(status.sessionCredsExpiresAt).toBeUndefined();
  });

  it("applySessionEnv on an unregistered MCP returns applied:false", async () => {
    const sup = makeSupervisor();
    const result = await sup.applySessionEnv("does-not-exist", { FOO: "x" });
    expect(result.applied).toBe(false);
  });

  it("statusList does NOT expose sessionEnv values (W-S9 L7)", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("theta")]);

    const SECRET = "tok_leak_test_does_not_appear";
    await sup.applySessionEnv("theta", { LOCAL_KEY: SECRET });

    const statuses = sup.statusList();
    const blob = JSON.stringify(statuses);
    expect(blob).not.toContain(SECRET);
  });

  it("statusList exposes sessionEnvKeys NAMES (so the UI can render a redacted placeholder)", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("iota")]);

    const SECRET = "tok_leak_test_value_must_not_appear";
    await sup.applySessionEnv("iota", { LOCAL_KEY: SECRET, OTHER_KEY: "another-value" });

    const status = sup.statusList().find((s) => s.name === "iota")!;
    // Names appear (sorted-or-paste-order isn't load-bearing; just present).
    expect(status.sessionEnvKeys).toEqual(expect.arrayContaining(["LOCAL_KEY", "OTHER_KEY"]));
    expect(status.sessionEnvKeys?.length).toBe(2);
    // Values still absent.
    const blob = JSON.stringify(status);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("another-value");
  });

  it("clearSessionEnv removes sessionEnvKeys from statusList", async () => {
    const sup = makeSupervisor();
    sup.register([specHttp("kappa")]);

    await sup.applySessionEnv("kappa", { LOCAL_KEY: "v" });
    expect(sup.statusList().find((s) => s.name === "kappa")?.sessionEnvKeys?.length).toBe(1);

    await sup.clearSessionEnv("kappa");
    const after = sup.statusList().find((s) => s.name === "kappa")!;
    expect(after.sessionEnvKeys).toBeUndefined();
  });
});

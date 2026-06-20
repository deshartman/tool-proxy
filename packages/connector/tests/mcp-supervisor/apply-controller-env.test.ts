import { describe, it, expect, beforeEach, vi } from "vitest";

import { McpSupervisor } from "../../src/mcp-supervisor.js";
import type { McpServerSpec } from "../../src/config.js";
import type { McpServerConnection } from "../../src/servers/index.js";

// Defensive tests for McpSupervisor.applyControllerEnv — the no-op-skip
// path that prevents an empty creds-response from killing a healthy
// running child. The bug this pins (boot 2026-06-21 against a controller
// with no creds rows): every creds-response arrived as
// `{source: "none", env: {}}`, applyControllerEnv called restartEntry
// anyway because `entry.child` was set, the SIGTERM raced an in-flight
// fetch, ECONNREFUSED bubbled up as an unhandled rejection, connector
// crashed.
//
// docs/MCP-PROTOCOL.md §"creds-response" allowed shapes spec the empty
// reply as "no row exists yet — connector falls back to dir/.env" — NOT
// "restart everything." This test pins the gate.
//
// Strategy: drive applyControllerEnv directly. We don't spawn real
// children — instead we plant a fake child handle on the entry to
// simulate "running" state, then assert the no-op branches return
// {applied: true, restarted: false} without touching the supervisor's
// stop/start primitives. A non-empty payload exercises the restart
// branch and we assert it DOES try to stop the child (we can't observe
// a real respawn without a real child, so we verify by the sentinel:
// `entry.child` becomes undefined after the stop step).

interface SupervisorPrivates {
  entries: Map<string, {
    spec: McpServerSpec;
    controllerEnv: Record<string, string>;
    child: { kill: (signal: string) => void; once: (event: string, cb: () => void) => void; exitCode: number | null; signalCode: string | null } | undefined;
    connection?: McpServerConnection;
    status: { credsSource: string; credsLastUpdated?: number };
  }>;
}

function buildSupervisor(): { supervisor: McpSupervisor; privates: SupervisorPrivates } {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "info",
    child: () => log,
  } as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"];
  const supervisor = new McpSupervisor({
    log,
    servers: new Map(),
  });
  return { supervisor, privates: supervisor as unknown as SupervisorPrivates };
}

function plantRunningEntry(
  privates: SupervisorPrivates,
  name: string,
  controllerEnv: Record<string, string> = {},
): void {
  // Simulate a spec with `dir` (Type 1) — the supervisor doesn't read
  // anything off it for the applyControllerEnv code path.
  const spec = { name, transport: "http", dir: "/dev/null" } as unknown as McpServerSpec;
  const fakeChild = {
    kill: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => cb()),
    exitCode: null as number | null,
    signalCode: null as string | null,
  };
  privates.entries.set(name, {
    spec,
    controllerEnv,
    child: fakeChild,
    status: { credsSource: "none" },
  });
}

describe("McpSupervisor.applyControllerEnv no-op skip", () => {
  let supervisor: McpSupervisor;
  let privates: SupervisorPrivates;

  beforeEach(() => {
    ({ supervisor, privates } = buildSupervisor());
  });

  it("returns restarted=false for source: 'none' with empty env (the boot crash repro)", async () => {
    plantRunningEntry(privates, "sample");
    const beforeChild = privates.entries.get("sample")?.child;

    const result = await supervisor.applyControllerEnv("sample", {}, "none", "creds-response");

    expect(result).toEqual({ applied: true, restarted: false });
    // Child handle untouched — restart did NOT fire. This is the
    // load-bearing assertion: the bug was "child gets stopped anyway."
    expect(privates.entries.get("sample")?.child).toBe(beforeChild);
    expect(beforeChild?.kill).not.toHaveBeenCalled();
  });

  it("returns restarted=false when controller env equals the previously-applied env", async () => {
    plantRunningEntry(privates, "crm", { CRM_TOKEN: "abc" });
    const beforeChild = privates.entries.get("crm")?.child;

    const result = await supervisor.applyControllerEnv(
      "crm",
      { CRM_TOKEN: "abc" },
      "operator-entered",
      "creds-response",
    );

    expect(result).toEqual({ applied: true, restarted: false });
    expect(privates.entries.get("crm")?.child).toBe(beforeChild);
    expect(beforeChild?.kill).not.toHaveBeenCalled();
  });

  it("returns restarted=false for source: 'none' even when env has stale keys (still 'no row' semantics)", async () => {
    plantRunningEntry(privates, "apis", { OLD_KEY: "stale" });
    const beforeChild = privates.entries.get("apis")?.child;

    // source: "none" + non-empty env shouldn't really happen per spec, but
    // if it does, the empty-payload guard only fires when env is empty —
    // the sameAsPrev guard is the second line of defence. Here neither
    // applies (env differs, source is "none"), so the supervisor falls
    // through to the restart branch.
    const result = await supervisor.applyControllerEnv("apis", {}, "none", "creds-response");

    expect(result).toEqual({ applied: true, restarted: false });
    expect(privates.entries.get("apis")?.child).toBe(beforeChild);
  });

  it("returns applied=false when MCP is unknown (no entry registered)", async () => {
    const result = await supervisor.applyControllerEnv(
      "ghost",
      { X: "y" },
      "operator-entered",
      "creds-update",
    );

    expect(result).toEqual({ applied: false, restarted: false });
  });

  it("envEquals: skip restart when an apparent change is just key reordering or value re-assertion", async () => {
    // The coordinator's stripEmptyValues is the first line of defense
    // against the "empty string vs omitted" controller bug. The
    // supervisor's envEquals is the second: even if the strip is
    // bypassed (e.g. a future caller goes direct to applyControllerEnv),
    // an env that's structurally identical to the prior one MUST NOT
    // restart the child.
    plantRunningEntry(privates, "apis", { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" });
    const beforeChild = privates.entries.get("apis")?.child;

    // Same key set, same values — applyControllerEnv must skip restart.
    const result = await supervisor.applyControllerEnv(
      "apis",
      { TWILIO_AUTH_TOKEN: "tok", TWILIO_ACCOUNT_SID: "AC123" },  // reordered
      "twilio-tunnel-row",
      "creds-update",
    );

    expect(result).toEqual({ applied: true, restarted: false });
    expect(privates.entries.get("apis")?.child).toBe(beforeChild);
    expect(beforeChild?.kill).not.toHaveBeenCalled();
  });

  it("envEquals: detect a genuine value change even when key set is identical", async () => {
    // Mirror of the above: same keys, different value should restart.
    plantRunningEntry(privates, "apis", { TWILIO_AUTH_TOKEN: "old" });
    const beforeChild = privates.entries.get("apis")?.child;

    await supervisor
      .applyControllerEnv(
        "apis",
        { TWILIO_AUTH_TOKEN: "new" },
        "twilio-tunnel-row",
        "creds-update",
      )
      .catch(() => undefined);

    expect(privates.entries.get("apis")?.child).toBeUndefined();
    expect(beforeChild?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("DOES restart when controller supplies a genuinely new env (the legitimate creds-update path)", async () => {
    plantRunningEntry(privates, "crm", { CRM_TOKEN: "old" });
    const beforeChild = privates.entries.get("crm")?.child;
    expect(beforeChild?.kill).not.toHaveBeenCalled();

    // We expect this to attempt a restart; restart will fail at the
    // respawn step (no real child setup), so wrap in try/catch and assert
    // the *stop* portion did fire — that's the mirror of the no-op test
    // above.
    await supervisor
      .applyControllerEnv(
        "crm",
        { CRM_TOKEN: "new" },
        "operator-entered",
        "creds-update",
      )
      .catch(() => undefined);

    // After stopEntry, child handle is cleared.
    expect(privates.entries.get("crm")?.child).toBeUndefined();
    expect(beforeChild?.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

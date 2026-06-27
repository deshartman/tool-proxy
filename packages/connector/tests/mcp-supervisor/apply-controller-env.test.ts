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

  it("stopEntry clears spec.endpoint and __port for Type 1 entries (so the next start re-enters spawnChild)", async () => {
    // Defensive test for the boot 2026-06-21 (second crash) ECONNREFUSED.
    // Symptom: a creds-update for the apis MCP killed the running child
    // (SIGTERM, code 143), then tried to *connect* to the dead port instead
    // of respawning — fetch failed: connect ECONNREFUSED 127.0.0.1:7102.
    //
    // Root cause: spawnChild() mutates spec.endpoint to the auto-assigned
    // localhost URL after readiness probe. On a subsequent startEntry,
    // isType1Spawn(spec) returns false (endpoint is set), so spawnChild
    // is skipped and connectServer dials the dead port. The fix clears
    // endpoint + __port in stopEntry so the spec is re-classified as
    // Type 1 spawn on the next start.
    //
    // This test plants the post-spawn state directly (endpoint + __port set)
    // and verifies that applying a new controller env — which triggers
    // restartEntry → stopEntry → startEntry — clears the mutated fields.
    plantRunningEntry(privates, "apis", { TWILIO_AUTH_TOKEN: "old" });
    const entry = privates.entries.get("apis");
    expect(entry).toBeDefined();
    // Mutate the spec to the post-spawn shape that spawnChild() produces.
    const mutSpec = entry?.spec as { endpoint?: string; __port?: number };
    mutSpec.endpoint = "http://127.0.0.1:7102/mcp";
    mutSpec.__port = 7102;

    await supervisor
      .applyControllerEnv(
        "apis",
        { TWILIO_AUTH_TOKEN: "new" },
        "twilio-tunnel-row",
        "creds-update",
      )
      .catch(() => undefined);

    // After stopEntry, the spec must be back to the pre-spawn shape so the
    // next startEntry call re-enters spawnChild. If this regresses, future
    // restarts for Type 1 children will leave the connector calling
    // connectServer against a dead port.
    expect(mutSpec.endpoint).toBeUndefined();
    expect(mutSpec.__port).toBeUndefined();
  });
});

// Stdio entries — the supervisor-merge bug fix 2026-06-28.
//
// Two related invariants this group pins:
//
//   1. RESTART TRIGGER: a creds-update / session-creds push for a running
//      stdio MCP MUST trigger restartEntry. Before the fix, the restart
//      gate was `if (entry.child)` — but stdio entries leave entry.child
//      unset (the SDK's StdioClientTransport owns the spawn internally),
//      so the gate was always false and stdio MCPs ignored every creds
//      rotation until the connector restarted. Now: `if (entry.child ||
//      entry.connection)`. The connection is the only alive-marker we
//      have for stdio; either suffices for HTTP/bundled.
//
//   2. The bug 2026-06-28 root cause: a controller-config stdio MCP
//      (e.g. @deshartman/twilio-mcp via "New 3rd Party MCP" UI) booted
//      with empty process.env because connectStdio built its env from
//      process.env + spec.env, ignoring controllerEnv. The supervisor
//      now passes mergedEnv to connectServer for stdio entries — a
//      change in src/mcp-supervisor.ts startEntry. The transport-level
//      contract pin lives in tests/servers/connect-dispatch.test.ts;
//      THIS group pins the supervisor-side restart trigger.

function plantRunningStdioEntry(
  privates: SupervisorPrivates,
  name: string,
  controllerEnv: Record<string, string> = {},
): { mockClose: ReturnType<typeof vi.fn> } {
  // Stdio spec — the only thing applyControllerEnv reads is entry.spec.env
  // (via mergeEnv) and entry.connection (via the restart gate). No child
  // handle — that's the whole point of the test.
  const spec = { name, transport: "stdio", command: ["fake-mcp"] } as unknown as McpServerSpec;
  const mockClose = vi.fn(async () => undefined);
  privates.entries.set(name, {
    spec,
    controllerEnv,
    child: undefined,
    connection: { close: mockClose } as unknown as McpServerConnection,
    status: { credsSource: "none" },
  });
  return { mockClose };
}

describe("McpSupervisor stdio restart trigger (bug 2026-06-28)", () => {
  let supervisor: McpSupervisor;
  let privates: SupervisorPrivates;

  beforeEach(() => {
    ({ supervisor, privates } = buildSupervisor());
  });

  it("applyControllerEnv triggers restart for a running stdio MCP (entry.connection set, entry.child undefined)", async () => {
    // The load-bearing assertion. Before the fix, this test would have
    // returned `restarted: false` because the gate was `entry.child` only.
    // After: the OR-gate sees entry.connection and fires restartEntry,
    // which calls stopEntry → connection.close().
    const { mockClose } = plantRunningStdioEntry(privates, "twilio-api", { TWILIO_ACCOUNT_SID: "AC_old" });

    // The restart will fail at the respawn step (no real child setup), so
    // wrap in catch and assert the *stop* portion fired — same pattern as
    // the HTTP restart tests above.
    await supervisor
      .applyControllerEnv(
        "twilio-api",
        { TWILIO_ACCOUNT_SID: "AC_new", TWILIO_AUTH_TOKEN: "AT_new" },
        "operator-entered",
        "creds-update",
      )
      .catch(() => undefined);

    // Connection was closed (the stopEntry path for stdio). Before the
    // fix, connection.close() never fired — the bug we're pinning.
    expect(mockClose).toHaveBeenCalled();
    // New controllerEnv stuck (mutation happened before restart attempt).
    expect(privates.entries.get("twilio-api")?.controllerEnv).toEqual({
      TWILIO_ACCOUNT_SID: "AC_new",
      TWILIO_AUTH_TOKEN: "AT_new",
    });
  });

  it("applyControllerEnv no-op skip still applies for stdio (empty env from source: 'none')", async () => {
    // Symmetric with the HTTP path's first test — the empty-payload skip
    // MUST cover stdio too. A creds-response with empty env shouldn't
    // kill a running stdio child either.
    const { mockClose } = plantRunningStdioEntry(privates, "segment", { SEGMENT_WRITE_KEY: "old" });

    const result = await supervisor.applyControllerEnv("segment", {}, "none", "creds-response");

    expect(result).toEqual({ applied: true, restarted: false });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("applyControllerEnv leaves the gate alone when neither child nor connection exists (registered but not yet started)", async () => {
    // The addEntry → requestCreds → startOne path: applyControllerEnv runs
    // BEFORE the spawn. entry.connection is undefined at that point. The
    // OR-gate MUST NOT trigger a restart for a not-yet-running entry —
    // the env just buffers into controllerEnv for the upcoming spawn.
    privates.entries.set("pre-spawn", {
      spec: { name: "pre-spawn", transport: "stdio", command: ["x"] } as unknown as McpServerSpec,
      controllerEnv: {},
      child: undefined,
      connection: undefined,
      status: { credsSource: "none" },
    });

    const result = await supervisor.applyControllerEnv(
      "pre-spawn",
      { K: "v" },
      "operator-entered",
      "creds-response",
    );

    // Applied (env buffered) but not restarted (nothing to restart yet).
    expect(result).toEqual({ applied: true, restarted: false });
    // Buffered correctly so the upcoming spawn picks it up.
    expect(privates.entries.get("pre-spawn")?.controllerEnv).toEqual({ K: "v" });
  });
});

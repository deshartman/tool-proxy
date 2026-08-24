import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { McpSupervisor, maskSecrets, parseChildRecord } from "../../src/mcp-supervisor.js";
import type { McpServerSpec } from "../../src/config.js";

// MCP-AUDIT #29 — a child's stdout/stderr must not reach the log stream
// unfiltered and unattributed.
//
// Children were spawned with stdio: ["ignore", "inherit", "inherit"], handing
// them the connector's own file descriptors, so everything they wrote bypassed
// connector code entirely: uncaught stack traces (printed by Node), raw
// process.stderr.write (used by the SDK's own dropin-runner), and upstream error
// bodies. pino's redact.paths could not help — it censors whole FIELDS by path,
// so censoring a free-text `line` field would blank the message rather than the
// secret inside it.
//
// What the fix guarantees, and what these tests pin:
//   * output is attributed to an MCP and rate-limited rather than unbounded
//   * secret VALUES the supervisor injected are masked in free text
// What it cannot guarantee: a secret the connector never knew. That is
// unknowable, and asserted nowhere.
//
// COVERAGE SPLIT, deliberately: the behavioural tests below call
// attachChildLogging directly, so they pin the MECHANISM but not the WIRING —
// they still pass if spawnChild stops calling it. The source trip-wire is what
// covers the wiring (verified: reintroducing `inherit` stdio and deleting the
// call fails the trip-wire and nothing else). Spawning a real child here just to
// prove one call site is not worth the flake; tests/integration/ has real-spawn
// coverage if that trade ever needs revisiting.

interface SupervisorPrivates {
  attachChildLogging: (entry: unknown, proc: ChildProcess) => void;
  entries: Map<string, unknown>;
}

interface Captured { level: string; obj: Record<string, unknown>; msg: string }

function buildSupervisor(): { privates: SupervisorPrivates; captured: Captured[]; supervisor: McpSupervisor } {
  const captured: Captured[] = [];
  const mk = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    captured.push({ level, obj, msg });
  };
  const log: Record<string, unknown> = {
    info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"),
    fatal: mk("fatal"), trace: mk("trace"), silent: vi.fn(), level: "info",
  };
  // .child() must carry bindings through, the way pino does — that is how
  // attribution reaches the record.
  log.child = (bindings: Record<string, unknown>) => {
    const childMk = (level: string) => (obj: Record<string, unknown>, msg: string) => {
      captured.push({ level, obj: { ...bindings, ...obj }, msg });
    };
    return {
      ...log,
      info: childMk("info"), warn: childMk("warn"), error: childMk("error"),
      debug: childMk("debug"), child: log.child,
    };
  };
  const supervisor = new McpSupervisor({
    log: log as unknown as Parameters<typeof McpSupervisor.prototype.constructor>[0]["log"],
    servers: new Map(),
  });
  return { privates: supervisor as unknown as SupervisorPrivates, captured, supervisor };
}

// A ChildProcess stand-in whose stdout/stderr we drive by hand.
function fakeChild(): { proc: ChildProcess; stdout: Readable; stderr: Readable } {
  const stdout = new Readable({ read() { /* pushed by the test */ } });
  const stderr = new Readable({ read() { /* pushed by the test */ } });
  const proc = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as ChildProcess;
  return { proc, stdout, stderr };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function register(supervisor: McpSupervisor, privates: SupervisorPrivates, name: string): unknown {
  supervisor.register([{ name, transport: "http", dir: "/dev/null" } as unknown as McpServerSpec]);
  return privates.entries.get(name);
}

describe("MCP-AUDIT #29 — child output is piped through the logger", () => {
  it("does not spawn with inherited stdio (source trip-wire)", async () => {
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/mcp-supervisor.ts", import.meta.url), "utf8"));
    // Strip line comments before matching. The source deliberately *describes*
    // the old `["ignore","inherit","inherit"]` form in its rationale comment, so
    // a naive negative match hits the explanation rather than live code — this
    // test failed exactly that way on first write.
    const code = raw
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toMatch(/stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/);
    expect(code).not.toMatch(/stdio:\s*\["ignore",\s*"inherit",\s*"inherit"\]/);
  });

  it("attributes each line to its MCP and splits on line boundaries, not chunks", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "chatty");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // Deliberately split a line across two chunks — the bug `data` handlers hit.
    stdout.push("first line\nsecond ");
    stdout.push("line\n");
    await flush();

    const lines = captured.filter((c) => c.obj.which !== undefined).map((c) => c.msg);
    expect(lines).toEqual(["first line", "second line"]);
    for (const rec of captured.filter((c) => c.obj.which !== undefined)) {
      expect(rec.obj.mcp).toBe("chatty");
      expect(rec.obj.stream).toBe("child");
    }
  });

  it("logs stderr at warn and stdout at info", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "mixed");
    const { proc, stdout, stderr } = fakeChild();
    privates.attachChildLogging(entry, proc);

    stdout.push("out\n");
    stderr.push("err\n");
    await flush();

    const byLine = new Map(captured.filter((c) => c.obj.which !== undefined).map((c) => [c.msg, c]));
    expect(byLine.get("out")?.level).toBe("info");
    expect(byLine.get("err")?.level).toBe("warn");
    expect(byLine.get("err")?.obj.which).toBe("stderr");
  });

  it("masks a controller-supplied credential echoed back in an error message", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "leaky") as { controllerEnv: Record<string, string> };
    entry.controllerEnv = { SF_CLIENT_SECRET: "sk-live-abcdef1234567890" };

    const { proc, stderr } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // The realistic shape: an OAuth error_description echoing the credential.
    stderr.push('Salesforce token request failed: invalid client_secret "sk-live-abcdef1234567890"\n');
    await flush();

    const line = captured.find((c) => c.obj.which !== undefined)?.msg as string;
    expect(line).not.toContain("sk-live-abcdef1234567890");
    expect(line).toContain("***");
    // The surrounding diagnostic must survive — masking, not blanking.
    expect(line).toContain("Salesforce token request failed");
  });

  it("masks the per-MCP webhook token", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "webhooky") as { webhookToken: string };
    const token = entry.webhookToken;
    expect(token.length).toBeGreaterThanOrEqual(43);

    const { proc, stderr } = fakeChild();
    privates.attachChildLogging(entry, proc);
    stderr.push(`GET /internal/webhook/stream failed, bearer=${token}\n`);
    await flush();

    const line = captured.find((c) => c.obj.which !== undefined)?.msg as string;
    expect(line).not.toContain(token);
    expect(line).toContain("***");
  });

  it("drops blank lines rather than logging empty messages", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "blanky");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    stdout.push("real\n\n   \n\t\nalso real\n");
    await flush();

    const lines = captured.filter((c) => c.obj.which !== undefined).map((c) => c.msg);
    expect(lines).toEqual(["real", "also real"]);
  });

  it("truncates a pathologically long line instead of logging it whole", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "verbose");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    stdout.push(`${"x".repeat(50_000)}\n`);
    await flush();

    const line = captured.find((c) => c.obj.which !== undefined)?.msg as string;
    expect(line.length).toBeLessThan(2200);
    expect(line).toContain("truncated");
  });

  it("rate-limits a flood and reports how many lines it dropped", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "flooder");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    for (let i = 0; i < 500; i++) stdout.push(`line ${i}\n`);
    stdout.push(null);            // EOF -> readline close -> suppressed flush
    await flush();
    await flush();

    const emitted = captured.filter((c) => c.obj.which !== undefined && c.msg !== "child output rate-limited — lines dropped").length;
    expect(emitted).toBe(200);    // CHILD_LOG_MAX_LINES_PER_WINDOW

    const drop = captured.find((c) => c.msg === "child output rate-limited — lines dropped");
    expect(drop).toBeDefined();
    expect(drop?.obj.suppressed).toBe(300);
  });
});

describe("MCP-AUDIT #29 — a child's own pino JSON is unwrapped, not double-encoded", () => {
  it("lifts the child's msg and keeps its fields under `child`", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "jsonny");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // Exactly what the SDK's createLogger emits — observed live on boot.
    stdout.push(JSON.stringify({
      level: 30, time: 1787548641699, pid: 94323, hostname: "host",
      component: "agentic-memory", port: 7100, msg: "listening",
    }) + "\n");
    await flush();

    const rec = captured.find((c) => c.obj.which !== undefined);
    // Before the fix this was the whole JSON blob as a string.
    expect(rec?.msg).toBe("listening");
    expect(rec?.msg).not.toContain("{");
    const child = rec?.obj.child as Record<string, unknown>;
    expect(child.component).toBe("agentic-memory");
    expect(child.port).toBe(7100);
    // Noise the outer record already carries is dropped.
    expect(child).not.toHaveProperty("pid");
    expect(child).not.toHaveProperty("hostname");
    expect(child).not.toHaveProperty("level");
  });

  it("honours the child's own level rather than the stream it arrived on", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "leveller");
    const { proc, stdout } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // A child logging at error on STDOUT must still surface as error.
    stdout.push(JSON.stringify({ level: 50, time: 1, msg: "boom" }) + "\n");
    await flush();
    expect(captured.find((c) => c.msg === "boom")?.level).toBe("error");
  });

  it("still masks secrets inside a structured record's field values", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "structleak") as { controllerEnv: Record<string, string> };
    entry.controllerEnv = { API_TOKEN: "tok-abcdefgh12345678" };
    const { proc, stderr } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // Masking runs on the raw text before the parse, so a field value is covered.
    stderr.push(JSON.stringify({ level: 40, time: 1, msg: "auth failed", sent: "tok-abcdefgh12345678" }) + "\n");
    await flush();

    const rec = captured.find((c) => c.msg === "auth failed");
    expect((rec?.obj.child as Record<string, unknown>).sent).toBe("***");
  });

  it("leaves a non-JSON line on the plain-text path", async () => {
    const { privates, captured, supervisor } = buildSupervisor();
    const entry = register(supervisor, privates, "plain");
    const { proc, stderr } = fakeChild();
    privates.attachChildLogging(entry, proc);

    // What dropin-runner's raw stderr.write and Node's stack traces look like.
    stderr.push("dropin-runner: DROPIN_DIR and DROPIN_NAME must be set\n");
    await flush();

    const rec = captured.find((c) => c.obj.which !== undefined);
    expect(rec?.msg).toBe("dropin-runner: DROPIN_DIR and DROPIN_NAME must be set");
    expect(rec?.obj.child).toBeUndefined();
    expect(rec?.level).toBe("warn");
  });
});

describe("parseChildRecord", () => {
  it("rejects a bare JSON payload that is not a log record", () => {
    // A child printing a tool result must not be mistaken for a log line.
    expect(parseChildRecord('{"records":[{"Id":"001"}],"totalSize":1}')).toBeUndefined();
  });

  it("rejects non-JSON, arrays, and malformed JSON", () => {
    expect(parseChildRecord("plain text")).toBeUndefined();
    expect(parseChildRecord('[{"level":30,"time":1}]')).toBeUndefined();
    expect(parseChildRecord('{"level":30,"time":')).toBeUndefined();
  });

  it("maps pino numeric levels", () => {
    expect(parseChildRecord('{"level":30,"time":1,"msg":"a"}')?.level).toBe("info");
    expect(parseChildRecord('{"level":40,"time":1,"msg":"a"}')?.level).toBe("warn");
    expect(parseChildRecord('{"level":50,"time":1,"msg":"a"}')?.level).toBe("error");
    expect(parseChildRecord('{"level":60,"time":1,"msg":"a"}')?.level).toBe("error");
  });

  it("falls back to a placeholder when the record has no msg", () => {
    expect(parseChildRecord('{"level":30,"time":1,"component":"x"}')?.msg).toBe("child output");
  });
});

describe("maskSecrets", () => {
  it("replaces every occurrence, not just the first", () => {
    expect(maskSecrets("a=SEKRIT99 b=SEKRIT99", ["SEKRIT99"])).toBe("a=*** b=***");
  });

  it("masks the longer value whole when one secret contains another", () => {
    // secretValuesFor sorts longest-first precisely so this holds.
    const secrets = ["abcdefgh12345", "abcdefgh"].sort((a, b) => b.length - a.length);
    expect(maskSecrets("token=abcdefgh12345", secrets)).toBe("token=***");
  });

  it("leaves the line untouched when no secret is present", () => {
    expect(maskSecrets("nothing to see", ["SEKRIT99"])).toBe("nothing to see");
  });

  it("is a no-op with no secrets", () => {
    expect(maskSecrets("plain", [])).toBe("plain");
  });
});

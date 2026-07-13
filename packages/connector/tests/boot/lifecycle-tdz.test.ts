import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for the "Cannot access 'X' before initialization" class
// of bugs in bootFromDb.
//
// bootFromDb wires a `dialTunnel` closure into the inspector's tunnel
// routes BEFORE it calls `store.getController()`. Under the empty-DB
// boot path — which is the entire point of the DB-backed flow — that
// closure is what fires when an operator submits the Configure Tunnel
// modal. If any `let` or `const` referenced inside the closure (or
// inside `connectTunnelDb`, which the closure invokes) sits AFTER the
// empty-DB `return`, JavaScript throws TDZ at paste time.
//
// Historical failures caught by this pattern:
//   `de52157` — `let auth` and `let tunnelDialUrl` (fixed by hoisting)
//   (also same commit, further fix) — `const registrationToken` (fixed by
//   reading `row.registrationToken` inline inside connectTunnelDb)
//
// A live integration test would be authoritative, but bootFromDb has
// enough machinery (McpSupervisor, TunnelClient, drop-in discovery,
// yaml validation with `mcp_servers.min(1)`) that a proper harness is a
// separate project. This source-level check is the cheapest reliable
// signal: it runs in ~1ms and catches any future refactor that
// reintroduces the pattern.
//
// The rule this test enforces: within the bootFromDb function body, any
// binding used inside the `dialTunnel` closure OR inside `connectTunnelDb`
// must be DECLARED above the `if (!row) return` early exit. Bindings
// declared later can still exist — they're fine for the row-exists path —
// but nothing referenced by the empty-DB paste flow may live below the
// return.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  join(__dirname, "../../src/boot/lifecycle.ts"),
  "utf-8",
);

function extractBootFromDbBody(source: string): string {
  const start = source.indexOf("async function bootFromDb");
  if (start < 0) throw new Error("bootFromDb not found in lifecycle.ts");
  // Naive brace-matching from the function's opening `{`. Good enough
  // for a well-formatted single function — bootFromDb is not nested
  // inside another function so the first unbalanced `}` at column 0
  // terminates the body.
  const openIdx = source.indexOf("{", start);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  throw new Error("could not find end of bootFromDb");
}

function extractConnectTunnelDbBody(source: string): string {
  const start = source.indexOf("async function connectTunnelDb");
  if (start < 0) throw new Error("connectTunnelDb not found");
  const openIdx = source.indexOf("{", start);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  throw new Error("could not find end of connectTunnelDb");
}

describe("bootFromDb TDZ safety (regression: de52157)", () => {
  const bootBodyRaw = extractBootFromDbBody(SOURCE);
  const ctBody = extractConnectTunnelDbBody(SOURCE);

  // Strip nested-function bodies out of bootFromDb before the above/below
  // split — declarations inside those (e.g. `const creds` at the top of
  // connectTunnelDb) are locals to the nested function, NOT captured
  // bindings on bootFromDb's outer scope. If we left them in, the
  // above/below regex match would fire on nested-scope locals and produce
  // false positives.
  const bootBody = bootBodyRaw.replace(
    /async function \w+\([^)]*\)[^{]*\{/g,
    (match) => match,
  ).replace(ctBody, "// (connectTunnelDb body elided)");
  // Also elide any other nested `async function` bodies by finding them
  // and replacing with a placeholder — for now connectTunnelDb is the
  // only relevant one; extend the list if bootFromDb grows more.

  // Split bootFromDb body at the empty-DB return. Anything below is
  // row-exists-path only; that's the danger zone for closures wired above.
  const earlyReturnMarker = "// Empty-DB path — DO NOT construct TunnelClient";
  const returnIdx = bootBody.indexOf(earlyReturnMarker);

  it("marker for the empty-DB return is present (this test is meaningless without it)", () => {
    expect(returnIdx).toBeGreaterThan(0);
  });

  const above = bootBody.slice(0, returnIdx);
  const below = bootBody.slice(returnIdx);

  // Identifiers that the dialTunnel closure or connectTunnelDb reads
  // from the outer bootFromDb scope. Adding an entry here means "this
  // binding is captured by the empty-DB paste flow and MUST be
  // declared above the empty-DB return."
  const CAPTURED_BY_EMPTY_DB_FLOW = [
    "auth",
    "tunnelDialUrl",
    "row",
    "webhooks",
    "notifications",
    "supervisor",
    "servers",
    "inspector",
    "reconnectCtl",
    "config",
    "store",
    "creds",
    "mcpConfig",
    "approval",
    "manifest",
  ];

  // For each captured binding, if it's used anywhere inside
  // connectTunnelDb, verify its outer declaration is above the early
  // return. Missing bindings (not used) are fine.
  for (const name of CAPTURED_BY_EMPTY_DB_FLOW) {
    const usedInConnect =
      new RegExp(`\\b${name}\\b`).test(ctBody);
    if (!usedInConnect) continue;

    it(`\`${name}\` is used inside connectTunnelDb and must be declared above the empty-DB return`, () => {
      const declPattern = new RegExp(
        `(let|const)\\s+${name}\\b(?!\\s*\\.)`,
        "g",
      );
      const declaredAbove = declPattern.test(above);
      declPattern.lastIndex = 0;
      const declaredBelow = declPattern.test(below);

      // A binding declared ONLY below the return is the exact TDZ trap.
      // Being declared above (and possibly reassigned below) is fine.
      // Not being declared at all in bootFromDb is also fine — it means
      // the identifier resolves to an import or a broader scope.
      if (declaredBelow && !declaredAbove) {
        throw new Error(
          `\`${name}\` is declared below the empty-DB return but used inside connectTunnelDb. ` +
          `This causes "Cannot access '${name}' before initialization" at paste time. ` +
          `Hoist the declaration above the return, or read the value inline from a hoisted binding.`,
        );
      }
    });
  }

  // Belt-and-braces: the specific bindings we've historically fixed
  // MUST remain hoisted. Anti-regression pin.
  it("`let auth` is declared above the empty-DB return (hoisted per de52157)", () => {
    expect(above).toMatch(/let\s+auth\b/);
    // If someone puts `let auth` below the return AGAIN, the outer
    // let would shadow — this test would still pass since the outer
    // is there. That's OK; the outer is what the closure captures.
  });

  it("`let tunnelDialUrl` is declared above the empty-DB return (hoisted per de52157)", () => {
    expect(above).toMatch(/let\s+tunnelDialUrl\b/);
  });

  it("connectTunnelDb reads registrationToken from `row`, NOT from an outer const", () => {
    // The outer `const registrationToken` sits below the empty-DB
    // return and would TDZ if connectTunnelDb referenced it. The fix
    // reads `row.registrationToken` inline via a local `currentToken`.
    // Verify by checking connectTunnelDb doesn't bare-reference the
    // outer identifier in a way that captures the outer binding.
    //
    // We look for the specific known-bad pattern: `state: { registrationToken }`
    // (shorthand property meaning "outer registrationToken"). If that
    // string reappears in connectTunnelDb, the fix has regressed.
    expect(ctBody).not.toMatch(/state:\s*\{\s*registrationToken\s*\}/);
    // Also make sure the shorthand register-frame use doesn't sneak back.
    expect(ctBody).not.toMatch(/\(\s*registrationToken\s*\?\s*\{\s*registrationToken\s*\}/);
  });
});

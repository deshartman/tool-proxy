import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/fly-inspector.sh gives an admin one command to open the Inspector on
// a Fly deployment. The Inspector is loopback-only by design and Fly offers no
// loopback-origin forward (fly proxy stops at the fdaa: mesh address; fly ssh
// has no -L), so the script starts a relay inside the Machine and forwards to
// that instead.
//
// The relay is the sharp edge: it launders the source address rather than
// authenticating, so while it runs, any peer on the org's private network can
// reach the full dashboard. Owning the teardown is therefore the script's main
// job, not a convenience — a hand-run relay was observed outliving its
// terminal by hours, parented to hallpass, keeping the dashboard exposed.
//
// Static checks: this cannot run flyctl in CI. Two properties below encode
// bugs found by actually running the thing, which is why they are pinned.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../../scripts/fly-inspector.sh");
const src = readFileSync(SCRIPT, "utf8");

describe("scripts/fly-inspector.sh", () => {
  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it("traps EXIT, INT and TERM", () => {
    // Ctrl-C is the documented way to finish, so INT must be trapped; EXIT
    // covers an early `exit 1` from a preflight, and TERM covers `kill`.
    expect(src).toMatch(/trap cleanup EXIT INT TERM/);
  });

  it("tears the relay down REMOTELY, not just by killing the local ssh client", () => {
    // This is the whole point. Killing the local `fly ssh` does NOT reliably
    // kill the remote child — that is exactly how the observed orphan
    // survived. Teardown must issue an explicit kill inside the Machine.
    const cleanup = src.slice(src.indexOf("cleanup() {"), src.indexOf("trap cleanup EXIT"));
    expect(cleanup).toMatch(/fly ssh console .* -C "pkill -f \$RELAY_MARKER"/);
  });

  it("verifies the relay is actually gone instead of assuming", () => {
    const cleanup = src.slice(src.indexOf("cleanup() {"), src.indexOf("trap cleanup EXIT"));
    expect(cleanup).toMatch(/grep -c "\$RELAY_MARKER"/);
    expect(cleanup).toMatch(/WARNING: a relay is still running/);
  });

  it("targets only its own relay, so a concurrent admin's survives", () => {
    // The marker carries the port, so two admins on different relay ports do
    // not tear down each other's session.
    expect(src).toMatch(/RELAY_MARKER="\$\{RELAY_MARKER_BASE\}_\$\{candidate\}"/);
    expect(src).toMatch(/\/\*\$\{RELAY_MARKER_BASE\}_\$\{port\}\*\//);
  });

  it("gives the relay a self-expiry as a backstop", () => {
    // If the script is SIGKILLed, no trap runs. The relay must still die.
    expect(src).toMatch(/RELAY_TTL_SECONDS=\d+/);
    expect(src).toMatch(/setTimeout\(\(\)=>\{console\.log\('relay expired'\);process\.exit\(0\)\}/);
  });

  it("does NOT gate the relay's lifetime on stdin EOF", () => {
    // First version exited on stdin 'end'. A backgrounded `fly ssh` has no
    // stdin, so 'end' fired immediately and the relay died right after
    // printing "relay up" — the tunnel then connected to nothing.
    expect(src).not.toMatch(/process\.stdin/);
  });

  it("proves the Inspector answers 200 before printing a URL", () => {
    // Handing over a URL that 403s is worse than failing: it looks like a
    // broken Inspector rather than a missing loopback hop.
    expect(src).toMatch(/w '%\{http_code\}'/);
    expect(src).toMatch(/\[ "\$code" = "200" \] && break/);
    expect(src).toMatch(/if \[ "\$code" = "403" \]/);
  });

  it("refuses to run when the app has a public IP", () => {
    // The connector is outbound-only; a public IP means the relay would widen
    // an exposure that should not exist at all.
    expect(src).toMatch(/fly ips list -a "\$APP"/);
    expect(src).toMatch(/has a public IP allocated/);
  });

  it("warns the operator what the relay exposes while it runs", () => {
    expect(src).toMatch(/reachable from your Fly/);
  });

  it("probes for a free port on both sides", () => {
    // Collisions are real: a leftover relay from the manual recipe held the
    // default port inside the Machine, and a local dev inspector or a stale
    // fly proxy holds it on the laptop.
    expect(src).toMatch(/for candidate in "\$RELAY_PORT"/);
    expect(src).toMatch(/port_free/);
  });

  it("defaults the app name from the checked-in fly.toml", () => {
    // "Simple for an admin" means zero arguments in the common case.
    expect(src).toMatch(/deploy\/fly\/fly\.toml/);
    expect(src).toMatch(/sed -n 's\/\^app \*= \*"/);
  });
});

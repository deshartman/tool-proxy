// Forward-proxy resolution for the outbound tunnel dial.
//
// WHY THIS EXISTS AT ALL. A common enterprise posture is that internal hosts
// cannot open arbitrary connections to the internet: the perimeter firewall
// drops direct egress on 443 and everything outbound must traverse a forward
// proxy via HTTP CONNECT, advertised to applications through HTTPS_PROXY /
// NO_PROXY. The connector's outbound-only design is compatible with that —
// the dial is still outbound-initiated — but it does not happen automatically.
//
// THE ASYMMETRY THAT MAKES THIS A TRAP (measured on Node 22.21.1, the version
// the Dockerfile pins):
//   * Node 22 supports `--use-env-proxy` / NODE_USE_ENV_PROXY=1, which wires
//     undici's EnvHttpProxyAgent into global fetch. So `auth/oauth-provider.ts`
//     (the OAuth token mint) and Type 2 external MCP endpoints — both fetch —
//     are proxied for free, with no code.
//   * `ws` is NOT. It drives the upgrade through node:https with its own agent,
//     and undici does not sit under node:https, so NODE_USE_ENV_PROXY cannot
//     reach it. It dials direct and times out.
//
// The consequence is the reason this module is worth its weight: on the OAuth2
// posture, a proxy-mandated customer sees the token mint SUCCEED through the
// proxy and the WSS dial to the same host then time out at DIAL_TIMEOUT_MS.
// Auth works, tunnel doesn't — which reads as a broken controller endpoint
// rather than a half-honoured proxy, and sends the operator debugging the
// wrong system.
//
// Note this reads env vars rather than adding config. HTTPS_PROXY / NO_PROXY
// are pre-existing de facto standards that ops teams set fleet-wide, and half
// this connector's egress already honours them via Node. Adding a proxy field
// to the sealed controllers row would be a second, competing source of truth
// for something the environment already states.

import { envOptional } from "../env.js";

export interface ProxyDecision {
  // The proxy to dial through, or undefined to dial direct.
  proxyUrl: string | undefined;
  // Why we decided that. Drives the log line: "excluded" and "none" are
  // silent normal operation, but "none" WITH a proxy var set in the
  // environment is the diagnostic case worth speaking up about.
  reason: "none" | "proxy" | "excluded";
  // True when the environment advertises a proxy at all, regardless of
  // whether it applies to this target. A dial failure with this true and
  // reason !== "proxy" is very nearly a diagnosis rather than a guess.
  proxyConfigured: boolean;
}

// Which env var applies, honouring the usual precedence: the scheme-specific
// var wins, lowercase beats uppercase (curl's convention). Empty string is
// treated as "not set" per the connector-wide rule in src/env.ts — an admin
// writing `HTTPS_PROXY=` means "no proxy", not "proxy at the empty URL".
function proxyVarFor(protocol: string, env: NodeJS.ProcessEnv): string | undefined {
  const secure = protocol === "https:" || protocol === "wss:";
  const names = secure
    ? ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
    : ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];
  for (const name of names) {
    const value = envOptional(name, env);
    if (value) return value;
  }
  return undefined;
}

// Host normalisation shared by the loopback check and NO_PROXY matching.
// URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), and a trailing
// root dot ("host.example.com.") is legal in a URL, so both are stripped here
// rather than at each comparison site.
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

// Loopback is exempt from proxying unconditionally — see the call site in
// resolveProxy for why this is NOT folded into matchesNoProxy.
function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  // *.localhost is loopback per RFC 6761; 127.0.0.0/8 is all loopback, not
  // just 127.0.0.1.
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h.startsWith("127.");
}

// Strip a port qualifier from a NO_PROXY entry. Deliberate simplification:
// we match on host and IGNORE any port, so "example.com:8443" exempts that
// host on every port. curl honours the port, but doing so would mean threading
// the target port through this function for a case that cannot arise here —
// the connector dials exactly one controller URL, so a port-qualified entry
// that matches the host but not the port would be an operator writing a rule
// aimed at something other than this connection.
function stripPort(entry: string): string {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    return end === -1 ? entry : entry.slice(1, end);
  }
  // One colon is host:port. Several means a bare IPv6 literal, which has no
  // port to strip.
  const first = entry.indexOf(":");
  if (first !== -1 && entry.indexOf(":", first + 1) === -1) return entry.slice(0, first);
  return entry;
}

// Does the NO_PROXY list exempt `host` from proxying? Returns true to dial
// DIRECT. Follows curl's semantics, which is the point: an ops team's existing
// NO_PROXY should behave here the way it does for every other tool on the box.
//
//   "*"              — bypass everything.
//   "example.com"    — matches example.com AND api.example.com (suffix), but
//                      NOT notexample.com: the suffix must land on a dot
//                      boundary, which is what stops that false positive.
//   ".example.com"   — a leading dot is ignored, exactly as curl ignores it,
//                      so this behaves identically to the entry above.
//   "example.com:80" — port ignored; see stripPort.
//
// Entries are comma- or whitespace-separated and matched case-insensitively.
export function matchesNoProxy(host: string, noProxy: string): boolean {
  const target = normalizeHost(host);
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const candidate = stripPort(entry.replace(/^\.+/, ""));
    if (!candidate) continue;
    if (target === candidate) return true;
    if (target.endsWith("." + candidate)) return true;
  }
  return false;
}

// Resolve whether this target should be dialed through a proxy.
// `targetUrl` is the fully-qualified wss:// (or https://) controller URL.
export function resolveProxy(targetUrl: string, env: NodeJS.ProcessEnv = process.env): ProxyDecision {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    // A malformed controller URL is the dial's problem to report, not ours.
    return { proxyUrl: undefined, reason: "none", proxyConfigured: false };
  }

  const proxyUrl = proxyVarFor(parsed.protocol, env);
  const proxyConfigured = proxyUrl !== undefined;
  if (!proxyUrl) return { proxyUrl: undefined, reason: "none", proxyConfigured };

  // Loopback first, and deliberately NOT inside matchesNoProxy: resolveProxy
  // only consults that when NO_PROXY is set, so folding it in would leave
  // loopback unexempted whenever HTTPS_PROXY is set on its own — the common
  // case. Our own spawned children live at http://127.0.0.1:<port>/mcp, and
  // CONNECTing to those through a corporate proxy would be refused.
  if (isLoopbackHost(parsed.hostname)) {
    return { proxyUrl: undefined, reason: "excluded", proxyConfigured };
  }

  const noProxy = envOptional("no_proxy", env) ?? envOptional("NO_PROXY", env);
  if (noProxy && matchesNoProxy(parsed.hostname, noProxy)) {
    return { proxyUrl: undefined, reason: "excluded", proxyConfigured };
  }

  return { proxyUrl, reason: "proxy", proxyConfigured };
}

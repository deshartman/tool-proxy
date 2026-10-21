// How tool and prompt names look on the wire. The proxy speaks protocol 3.x
// only (RENAME-TOOL-PROXY, hard cut): `<proxyId>.<server>.<name>`, parsed with
// the package's two-step rule so the name keeps any further dots. The
// Dispatcher is handed one of these per session. A controller that cannot speak
// 3.x refuses the register frame; there is no negotiating down.

import { parseQualifiedProxyToolName, qualifyProxyToolName } from "@gtmi/toolproxy-protocol";

export type ParsedName =
  | { ok: true; server: string; name: string }
  // Well-formed but addressed to a different proxy. Distinct from malformed so
  // the dispatcher can log a misroute, while replying exactly as it would for
  // an unknown server (no existence oracle).
  | { ok: false; reason: "foreign-proxy"; proxyId: string }
  | { ok: false; reason: "malformed" };

export interface WireNaming {
  compose(server: string, name: string): string;
  parse(wireName: string): ParsedName;
  /** Human-readable form, for the error a malformed name gets. */
  readonly shape: string;
}

export function qualifiedNaming(proxyId: string): WireNaming {
  return {
    shape: "${proxyId}.${server}.${name}",
    compose: (server, name) => qualifyProxyToolName(proxyId, server, name),
    parse: (wireName) => {
      const p = parseQualifiedProxyToolName(wireName);
      if (!p) return { ok: false, reason: "malformed" };
      if (p.proxyId !== proxyId) return { ok: false, reason: "foreign-proxy", proxyId: p.proxyId };
      return { ok: true, server: p.server, name: p.tool };
    },
  };
}

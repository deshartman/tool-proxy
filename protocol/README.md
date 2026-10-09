# @gtmi/toolproxy-protocol

The wire protocol for the MCP tool-proxy tunnel: the WebSocket link between a
**connector**, which runs behind a firewall next to local MCP servers, and a
**controller**, which drives them.

It ships Zod schemas for every tunnel frame in **both protocol majors** (`v1`,
`v2`), TypeScript types derived from those schemas, a frame parser that picks the
right major for each peer, and the tool-name helpers both sides use. The connector owns
this package. Controllers depend on it and do not define frames of their own,
so the two sides cannot drift apart.

## Install

```sh
npm install @gtmi/toolproxy-protocol zod
```

`zod` (v4) is a peer dependency, so your application and this package share one
copy.

## Parse an inbound frame

```ts
import { parseFrame, parseVersion } from "@gtmi/toolproxy-protocol";

// A controller receiving from a connector:
const result = parseFrame("connector-to-controller", rawText, {
  peer: parseVersion(registerFrame.tunnelProtocol), // once known
});

if (result.ok) {
  handle(result.frame);           // fully typed, discriminated on `type`
} else if (result.ignored) {
  // A newer-minor peer sent a frame type we don't know. Not an error.
} else {
  log.warn({ type: result.type, issues: result.issues }, result.error);
}
```

`parseFrame` never throws. Its error results contain **only** the frame type and
the paths of the offending fields, never field values. Frames carry credentials
and tool arguments, so values must not end up in logs.

## Tool names (protocol 2.x)

In 2.x every tool is named `<shimId>.<server>.<tool>`. Server and tool names
travel **bare** inside descriptors; both sides compose and parse the qualified
form with these helpers, and neither reimplements them:

```ts
import { qualifyToolName, parseQualifiedToolName } from "@gtmi/toolproxy-protocol";

qualifyToolName("k3f9x2qa", "crm", "get_customer"); // "k3f9x2qa.crm.get_customer"

parseQualifiedToolName("k3f9x2qa.crm.get.customer");
// → { shimId: "k3f9x2qa", server: "crm", tool: "get.customer" }
```

The parse is **two-step**: the first `.` ends the shimId, the next `.` ends the
server, and the tool keeps any further dots. That is unambiguous only because
shimIds and server names never contain a dot, and the 2.x schemas enforce that
wherever a server name appears.

## Versioning

The tunnel protocol is versioned `<major>.<minor>`, exported as
`PROTOCOL_VERSION`. The connector sends it as `register.tunnelProtocol`, and the
controller echoes its supported range as
`register-ack.supportedTunnelProtocol`.

| Peer is on… | Parsing |
|---|---|
| The same minor, or an unknown version | **Strict**: an unknown field or frame type is rejected, at any depth |
| A newer minor of the same major | **Tolerant**: unknown fields are stripped and unknown frame types are ignored |
| A major this package carries no schemas for | Refused at `register-ack` with `unsupported_tunnel_protocol` |

This keeps additive changes deployable without upgrading both sides at once,
while still catching drift between peers that claim the same version.

**Majors are negotiated, not hard-cut.** This package carries the schemas for
majors 1 and 2, and `parseFrame` uses the peer's major (from
`register.tunnelProtocol`; absent means 1.0). A controller on this package can
therefore serve 1.x and 2.x connectors at once. `isSupportedPeer(peer)` says
whether a peer's major is one the package can parse.

`PROTOCOL_VERSION` is what a connector built on this package speaks by default,
and it is still `"1.0"` in package 2.0.0: shipping the 2.x schemas and switching
what a connector sends are separate steps. `LATEST_PROTOCOL_VERSION` is `"2.0"`.

The package's semver **major.minor equals the newest protocol major.minor it
carries** (`LATEST_PROTOCOL_VERSION`); it also carries every earlier major it
still negotiates. Depend on it with a tilde range, which pins that schema set and
accepts schema-fix patches:

```json
"@gtmi/toolproxy-protocol": "~2.0.0"
```

## License

MIT

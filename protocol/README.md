# @gtmi/toolproxy-protocol

The wire protocol for the MCP tool-proxy tunnel: the WebSocket link between a
**connector**, which runs behind a firewall next to local MCP servers, and a
**controller**, which drives them.

It ships Zod schemas for every tunnel frame, TypeScript types derived from those
schemas, and a frame parser that knows the protocol version. The connector owns
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

## Versioning

The tunnel protocol is versioned `<major>.<minor>`, exported as
`PROTOCOL_VERSION`. The connector sends it as `register.tunnelProtocol`, and the
controller echoes its supported range as
`register-ack.supportedTunnelProtocol`.

| Peer is on… | Parsing |
|---|---|
| The same minor, or an unknown version | **Strict**: an unknown field or frame type is rejected, at any depth |
| A newer minor of the same major | **Tolerant**: unknown fields are stripped and unknown frame types are ignored |
| A different major | Refused at `register-ack` with `unsupported_tunnel_protocol` |

This keeps additive changes deployable without upgrading both sides at once,
while still catching drift between peers that claim the same version.

The package's semver **major.minor equals the protocol's major.minor**, so depend
on it with a tilde range, which pins one protocol minor and accepts schema-fix
patches:

```json
"@gtmi/toolproxy-protocol": "~1.0.0"
```

## License

MIT

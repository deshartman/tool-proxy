# CREDS-ENCRYPTION — Plan

> **Goal.** Encrypt per-MCP credential values *end-to-end* between the controller and the connector child process, so that creds are never visible in cleartext on the wire (inside the TLS pipe), in the connector's frame buffer, in the inspector UI, or in any tunnel-side log. The connector decrypts only at the point of spawning the MCP child; before that point, every layer that touches creds sees ciphertext.
>
> **Branch.** `feature/creds-encryption` (cut from `main` after `feature/mcp-loading` lands).
>
> **Status.** Not started — planning only. Two precursor TODOs surfaced 2026-06-21:
>   - **TODO-A (inspector cleartext):** Frames panel shows `creds-response.env` values as JSON. Cheap fix, no protocol change.
>   - **TODO-B (wire-level encryption):** This document.
>
> **Self-describing.** A fresh-context Claude reads this file + linked source + [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) + [.claude/plans/MCP-LOADING.md](MCP-LOADING.md) and starts work. Controller-team instructions are §"Controller implementation" — that section is self-contained.

## Threat model — be explicit before designing

The decision rests on which of these threats we're closing. Each has a different cost:

| # | Threat | Today's posture | Closed by this plan? |
|---|---|---|---|
| 1 | **Network observer** between connector and controller (intercepting WSS traffic) | TLS — closed. | Already closed. |
| 2 | **Compromised TLS terminator on the controller side** (cloud LB, CDN, sidecar that terminates TLS before the controller process) | Open — frames are cleartext JSON inside the LB. | **Yes.** |
| 3 | **Controller-side log/observability access** (anyone with read access to controller WS frame logs, debug dumps, or APM traces) | Open. | **Yes.** |
| 4 | **Controller-side application bug** (errant `log.info(frame)` leaks env values to stdout) | Open. | **Yes** — frame body is ciphertext until decrypt. |
| 5 | **Connector-side observer with frame-buffer access** (inspector UI, connector logs) | Open. | **Yes** — connector decrypts only at spawn. |
| 6 | **Compromised connector process** (root on the connector host) | Open — child env vars are readable via `/proc/<pid>/environ`. | **No.** Out of scope. The connector must hold the decryption key in memory; root on the connector wins by definition. |
| 7 | **Operator with controller-DB access** (encryption-at-rest holes) | Closed by controller's existing DB encryption. | Orthogonal. |
| 8 | **Compromised connector at rest** (image extracted, disk inspected) | N/A — ephemeral keypair, in-memory only. | Closed by ephemeral key choice. |

**Threats #2–#5 are the ones enterprises ask about under "encryption in transit."** TLS doesn't cover them by itself — TLS terminates at the LB, the frame body is cleartext from there. App-layer encryption closes the gap. Threat #6 stays out of scope — same as today, no change.

**Compliance framing for the customer conversation.** The phrase "encrypted in transit" in SOC 2 / ISO 27001 / HIPAA-aligned audits means "no cleartext credentials traverse a network the customer doesn't fully control." TLS satisfies this on the wire, but auditors increasingly ask about the in-memory state at intermediate hops (LBs, sidecars, controller process). This design satisfies the stricter reading: a sealed envelope, opened only inside the connector process at spawn time.

## Design — sealed-box envelope encryption with ephemeral connector keypair

The fundamental shape: **the connector mints an X25519 keypair at boot, sends the public key to the controller in the `register` frame, the controller encrypts every credential value with `crypto_box_seal` (libsodium sealed-box) before putting it on the wire, and the connector decrypts inside the supervisor just before passing env to `child_process.spawn`.**

### Why X25519 sealed-box

- **Industry-standard primitive.** libsodium's `crypto_box_seal` — used by Signal, Wire, age, every recent secrets-encryption tool. NaCl-family, well-audited, no novel crypto.
- **No shared secret to provision.** The connector mints its keypair locally; the controller only ever sees the public half. Compromised controller cannot read past traffic from other connectors.
- **Asymmetric: controller can encrypt without holding the connector's private key.** Required for our trust model — we *want* the controller unable to decrypt the values it just sent (so a controller breach doesn't expose stored creds in flight).
- **Small ciphertexts.** Each sealed value adds 48 bytes (32-byte ephemeral pubkey + 16-byte MAC) to the plaintext. A typical AccountSid+AuthToken pair encrypts to ~200 bytes. Far below the 256 KB frame ceiling.
- **No key derivation, no nonce management, no AEAD-mode footguns.** Sealed-box internally generates a fresh ephemeral keypair per ciphertext, derives a shared secret with the recipient's pubkey via X25519, and authenticates with Poly1305. Caller passes plaintext + recipient pubkey, gets ciphertext.

**Rejected alternatives:**
- **AES-GCM with a shared symmetric key** — requires bootstrap of the shared key, and now both sides hold something that, if leaked, decrypts past traffic. Sealed-box's asymmetric property is exactly what we want.
- **Per-frame ECDH session keys** — overkill. Adds handshake latency and a session-state machine. Sealed-box is one-shot per value.
- **Encrypt the entire frame** — overkill. Only the env *values* need encryption; the frame envelope (`type`, `requestId`, `mcp`) is non-sensitive routing metadata. Encrypting it would also make debugging vastly harder.
- **mTLS on the WS upgrade** — closes threat #2 but not #3, #4, or #5. The TLS terminator still sees cleartext frames; the connector's inspector still renders them cleartext. mTLS is a separate concern (impersonation hardening) — different threat, different fix.

### Why ephemeral (in-memory only) keypair

The connector mints a fresh X25519 keypair on every process start. The private key lives in process memory, never touches disk. The public key is published to the controller in the next `register` frame.

**Implications:**
- **No key file to protect, rotate, or back up.** Removes an entire operational surface.
- **Restart = new keys = controller must re-encrypt for new pubkey.** Cheap on the controller side (re-fetch creds from DB, re-seal with new pubkey, push as `creds-update`). Triggered automatically by the `register` frame's new `connectorPublicKey` field.
- **Process memory dump still leaks keys.** Same security level as holding the cleartext creds in process memory — which the connector does today and must continue doing (env values are passed to child processes via `child_process.spawn`'s `env` option, which copies to the kernel). This isn't a regression; it's the intrinsic limit.
- **No state-file growth.** `.connector-state.json` keeps just `registrationToken` — no keypair persistence.

**Rejected — persistent keypair on disk:**
- Pros: pubkey stable across restarts, controller caches one ciphertext per (connector, mcp) and re-uses across reconnects.
- Cons: private key on disk = encryption-at-rest problem (HSM? file permissions? customer rotation story?), corrupt state file = unable to decrypt creds, key rotation needs an explicit ceremony.
- Verdict: **not worth the operational tax.** Re-encrypting on connector restart is cheap (a few KB of compute on the controller, one frame per MCP). We accept the trade.

## Wire format changes

### `register` frame — add `connectorPublicKey`

```ts
interface RegisterFrame {
  type: "register";
  manifest: ToolManifest;
  name?: string;
  registrationToken?: string;
  // NEW — base64-encoded 32-byte X25519 public key. Connector mints the
  // keypair at process start; private half stays in memory. Controller MUST
  // store this against the WS-authenticated connectorId for the duration of
  // this WS session and use it to seal every subsequent creds-response /
  // creds-update env value. On WS reconnect, connector mints a fresh pair
  // and re-publishes — controller MUST replace the cached pubkey, never
  // reuse the prior session's.
  connectorPublicKey: string;
}
```

**Rules:**
- Base64 (URL-safe, no padding) — matches the rest of the wire format style.
- Required when `protocolVersion >= "1.1"` (see §"Versioning").
- Connector throws at boot if `crypto.generateKeyPairSync('x25519', ...)` fails (Node ≥ 16 ships this in core; no extra dep needed).

### `creds-response` and `creds-update` — add `encryptedEnv`

The plaintext `env` field is **replaced** by `encryptedEnv: Record<string, string>`, where each value is a base64-encoded sealed-box ciphertext of the UTF-8 plaintext.

```ts
interface CredsResponseFrame {
  type: "creds-response";
  requestId: string;
  // CHANGED — was `env?: Record<string, string>` (cleartext).
  encryptedEnv?: Record<string, string>;   // base64 sealed-box ciphertexts
  source?: CredsSource;
  error?: string;
}

interface CredsUpdateFrame {
  type: "creds-update";
  mcp: string;
  // CHANGED — was `env: Record<string, string>` (cleartext).
  encryptedEnv: Record<string, string>;
  source: CredsSource;
  reason?: string;
}
```

**Rules:**
- **Keys stay cleartext.** `Object.keys(encryptedEnv)` reveals which env vars exist for this MCP — that's intentional; the controller already audits envKey *names* and the inspector needs to display them. Only *values* are sealed.
- **Per-value sealing, not per-frame.** Each value is independently sealed with the connector's pubkey. Lets the controller change one value without re-sending the rest, and lets the inspector render `key → "<encrypted, len=N>"` without faking a decrypt.
- **Empty-value rule preserved.** A key with an empty plaintext string is still treated as "absent" by the connector (per [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) §"creds-response — controller MUST omit absent keys"). The controller MUST omit absent keys from `encryptedEnv` rather than seal an empty string. Same rationale as today: the supervisor's `envEquals` no-op-skip guard treats `{}` and `{X: <ciphertext-of-empty>}` as different shapes.
- **Frame size budget.** Ciphertext expands by 48 bytes per value. A 20-key env block (largest realistic case) is still well under 4 KB. No risk against the 256 KB frame ceiling.

### `register-ack` — add `encryptionAck` (optional, diagnostic)

```ts
interface RegisterAckFrame {
  type: "register-ack";
  // ... existing fields ...
  // NEW — controller echoes back the SHA-256 of the connector's pubkey it
  // received, base64-encoded. Lets the connector confirm the controller
  // bound the right key (catches LB-reordering bugs where one connector's
  // pubkey gets matched against another's session).
  publicKeyFingerprint?: string;
}
```

Strictly diagnostic. Connector logs a warn if the fingerprint doesn't match its own pubkey's SHA-256, but doesn't disconnect (defence-in-depth — the per-value seal is the primary integrity check).

## Connector implementation

### Workstream E1 — Keypair lifecycle

**Where:** new module `packages/connector/src/crypto/connector-keypair.ts`.

**Shape:**

```ts
import { generateKeyPairSync, createPublicKey } from "node:crypto";

export interface ConnectorKeypair {
  publicKeyBase64: string;       // X25519 pubkey, raw 32 bytes, base64url no-pad
  decrypt(ciphertextBase64: string): string;  // sealed-box open
}

export function mintConnectorKeypair(): ConnectorKeypair { /* ... */ }
```

**Key decisions:**
- **Generated once per process.** Created in `main()` before `connectTunnel()`. Same instance lives the whole connector run.
- **Survives auto-reconnect.** When the existing reconnect loop fires, the same `ConnectorKeypair` instance is passed into the new `TunnelClient`. Controller sees the same pubkey across the reconnect, so its cached sealed values stay valid.
- **Replaced on cold restart only.** The connector process exiting is when the keypair changes. Hot reconnect keeps it.

**Sealed-box decrypt:** Node's `crypto` module added `crypto.createPrivateKey({ key: ..., format: 'jwk' })` and `crypto.diffieHellman()` for X25519 in v16, but does NOT ship a sealed-box primitive directly. Two implementation options:

| Option | Pros | Cons |
|---|---|---|
| **`tweetnacl` npm dep** (~50 KB) | Drop-in `nacl.box.open` after one `nacl_sealedbox_open` shim wrapper. Battle-tested in Signal, age-go ports. | Adds a dep to the connector. |
| **Hand-roll sealed-box on `node:crypto`** | No new dep. | ~80 lines of careful crypto glue: derive ephemeral pubkey from ciphertext prefix, X25519 via `crypto.diffieHellman`, HSalsa20 + Poly1305 via `crypto.createCipheriv('chacha20-poly1305')`. Sealed-box uses XSalsa20-Poly1305 historically; Node ships ChaCha20-Poly1305 — the construction differs in the nonce derivation step. |

**Recommendation: `tweetnacl`.** This is exactly the kind of code we should not hand-roll. Adds 50 KB to the runtime image; it's worth it.

### Workstream E2 — Plumb pubkey into `register` frame

**Where:** [packages/connector/src/boot/lifecycle.ts](../../packages/connector/src/boot/lifecycle.ts) — the boot path that builds the manifest and calls `tunnel.send({ type: "register", ... })`.

Pass the `ConnectorKeypair` into the lifecycle module from `main()`. When constructing the register frame, include `connectorPublicKey: keypair.publicKeyBase64`.

The TunnelClient itself stays crypto-agnostic — it just forwards a frame. The keypair lives one layer above, in lifecycle.ts.

### Workstream E3 — Decrypt at the supervisor boundary

**Where:** [packages/connector/src/tunnel/creds-coordinator.ts](../../packages/connector/src/tunnel/creds-coordinator.ts).

Today the coordinator strips empty values from `frame.env` and forwards to `supervisor.applyControllerEnv`. After this change:

```ts
handleResponse(frame: CredsResponseFrame): void {
  const pending = this.pending.get(frame.requestId);
  if (!pending) { /* unchanged */ return; }
  // ... existing requestId housekeeping ...

  const encryptedEnv = frame.encryptedEnv ?? {};
  const decryptedEnv = this.decryptEnv(encryptedEnv, pending.mcp, "creds-response");
  // stripEmptyValues stays — defence in depth in case the controller seals
  // an empty plaintext (which it shouldn't per the omit-absent rule, but
  // we don't trust the wire).
  const env = stripEmptyValues(decryptedEnv);
  // ... existing apply path ...
}

private decryptEnv(
  encryptedEnv: Record<string, string>,
  mcp: string,
  reason: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, ciphertext] of Object.entries(encryptedEnv)) {
    try {
      out[key] = this.opts.keypair.decrypt(ciphertext);
    } catch (err) {
      // Per-key failure is recoverable: log + drop the key, continue with
      // the rest. Other keys may still let the MCP function (e.g. Twilio
      // group registers, SendGrid group fails to decrypt → 16 tools register,
      // 4 don't). Inspector status panel shows partial-decrypt state.
      this.opts.log.error({ mcp, key, reason, err: err as Error },
        "creds decrypt failed — dropping key");
    }
  }
  return out;
}
```

Same shape for `handleUpdate`.

The decrypted `env` map is held only in the closure that calls `applyControllerEnv`. It does NOT linger in the coordinator's state. Same lifecycle as today's cleartext path.

### Workstream E4 — Inspector tap redaction (TODO-A — does double duty)

The inspector's `recordTap` in [packages/connector/src/inspector/server.ts](../../packages/connector/src/inspector/server.ts) currently records the frame verbatim. After E1–E3, the frame body for `creds-response` / `creds-update` carries `encryptedEnv` — which is opaque base64 to the inspector. **The inspector intrinsically cannot show plaintext anymore** because it doesn't have the decrypt key (the decrypt happens in the coordinator, not at the tap point).

This means:
- **TODO-A is partially auto-resolved** by E1–E3. The Frames panel shows ciphertext, not plaintext.
- **Still need a small render improvement** in `public/app.js`: render `encryptedEnv` values as `"<sealed, 248B>"` rather than the raw base64 blob, for visual cleanliness. Cosmetic, not security-critical.
- **MCP Status panel** keeps showing `keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]` (key names are not encrypted — that's intentional; operators need to know which keys are populated).

### Workstream E5 — Tests

| Test file | Pin |
|---|---|
| `packages/connector/tests/crypto/connector-keypair.test.ts` | `mintConnectorKeypair()` produces a valid X25519 pair; round-trip seal+open on a known fixture; rejects malformed ciphertext. |
| `packages/connector/tests/tunnel/creds-coordinator-encryption.test.ts` | `handleResponse` with `encryptedEnv` decrypts and forwards plaintext to the supervisor. Per-key decrypt failure does NOT abort the whole frame. Empty `encryptedEnv` (no row) still resolves the pending request with `{}`. |
| `packages/connector/tests/tunnel/register-frame.test.ts` | The boot-built register frame includes `connectorPublicKey` as a 32-byte base64 string. |
| `packages/connector/tests/integration/creds-encryption-e2e.test.ts` | End-to-end: stub controller seals fixture creds with the connector's pubkey from the register frame; connector applies decrypted env to a stub supervisor; assert stub spawn args contain the plaintext. |

Add a catalog row to [TEST-SUITE.md](TEST-SUITE.md).


## Controller implementation

> **Audience.** This section is for the controller team. It assumes you are working in the controller codebase, not the connector. The connector side is described above for context only — the contract you implement against is in §"Wire format changes."

### C1 — Capture the connector's pubkey on `register`

When a `register` frame arrives, parse `connectorPublicKey` (base64, 32 bytes) and store it in the in-memory session state for this WS connection, keyed by the WS-authenticated `connectorId`. Lifetime is the WS session only — drop it on close. **Do NOT persist it to the controller's database.**

```ts
// pseudocode
ws.on('frame', (frame) => {
  if (frame.type === 'register') {
    if (!frame.connectorPublicKey) {
      // Backwards-compat: older connector. See §"Backwards compat" below.
      session.connectorPublicKey = null;
    } else {
      const pubkey = base64UrlDecode(frame.connectorPublicKey);
      assertExactly32Bytes(pubkey);
      session.connectorPublicKey = pubkey;
    }
    // Echo SHA-256 fingerprint in register-ack for diagnostic confirmation.
    sendFrame({
      type: 'register-ack',
      connectorId: session.connectorId,
      publicKeyFingerprint: sha256Base64(pubkey),
      // ... other ack fields ...
    });
  }
});
```

### C2 — Replace `env` with `encryptedEnv` in every outbound frame

Every `creds-response` and `creds-update` frame the controller sends MUST seal each env value with the captured pubkey before the frame leaves the WS write buffer.

```ts
// pseudocode — using libsodium-wrappers
import sodium from 'libsodium-wrappers';
await sodium.ready;

function sealForConnector(plaintext: string, pubkey: Uint8Array): string {
  const ciphertext = sodium.crypto_box_seal(plaintext, pubkey);
  return sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function buildCredsResponse(
  requestId: string,
  envCleartext: Record<string, string>,
  source: 'twilio-tunnel-row' | 'operator-entered' | 'none',
  session: WsSession,
): CredsResponseFrame {
  if (!session.connectorPublicKey) {
    // Backwards-compat path — see §"Backwards compat".
    return { type: 'creds-response', requestId, env: envCleartext, source };
  }
  const encryptedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envCleartext)) {
    if (value === '') continue;  // omit-absent rule, unchanged
    encryptedEnv[key] = sealForConnector(value, session.connectorPublicKey);
  }
  return { type: 'creds-response', requestId, encryptedEnv, source };
}
```

**Library recommendation:** `libsodium-wrappers` (npm) for Node controllers; `pynacl` for Python; `golang.org/x/crypto/nacl/box` (use `Seal` + a randomly generated ephemeral key as `crypto_box_seal` is one-shot). All three are well-maintained and ship the exact `crypto_box_seal` primitive.

### C3 — Re-seal cached values on every WS reconnect

The controller likely caches "last-pushed creds per (connectorId, mcp)" to detect operator-driven changes worth pushing. Today these are stored cleartext in memory. After this change, the cache stores **cleartext** internally (so the controller can re-seal whenever the connector's pubkey changes), and seals at the moment of frame send.

**Why cleartext in the cache.** The controller already holds the cleartext (it just read it from its DB to send). Re-sealing requires the cleartext. Encrypting the cache adds complexity without raising the bar — same trust boundary applies (controller process memory).

**Re-seal trigger:** when `connectorPublicKey` arrives on a fresh `register` (i.e. a reconnect), iterate the cache for that `connectorId`, seal each entry with the new pubkey, push as `creds-update` per MCP. This re-syncs creds without operator action. **Important:** dedupe — if the cleartext didn't change, the connector's `envEquals` no-op-skip guard will recognize the new ciphertext as semantically equal AFTER decrypt and skip the restart. So re-sealing is cheap on the connector side too.

Actually — wait. Sealed-box ciphertexts include a fresh ephemeral keypair, so the *byte-level* ciphertext changes every time you seal the same plaintext. The connector can only compare AFTER decrypt. Two implications:
- **Connector's `envEquals` already happens AFTER decrypt** in our design — re-read [packages/connector/src/mcp-supervisor.ts](../../packages/connector/src/mcp-supervisor.ts). Good. The decrypt happens in `creds-coordinator.ts` (WS-frame layer) before `applyControllerEnv` is called, so `envEquals` compares plaintext maps. No regression.
- **Controller does NOT need to dedupe at the wire** — sending the same plaintext re-sealed across reconnects is semantically a no-op once the connector decrypts. But it is wasteful WS bandwidth; the controller SHOULD dedupe at the cache-read layer (only push if cleartext changed since last push for this connectorId) to avoid useless frames. Same logic as today's cache.

### C4 — Audit log update

Every `creds-update` audit log entry already records `(connectorId, mcp, operator, at)`. Add one field: `pubkeyFingerprint` (SHA-256 of the connector pubkey used to seal). Lets a forensic reader confirm which connector session received which frame, in case the same connectorId reconnects multiple times.

### C5 — Backwards compat — older connectors

If a `register` frame arrives WITHOUT `connectorPublicKey` (older connector), the controller MUST fall back to the v1 cleartext `env` shape. Detection rule:

```ts
const useEncryption = !!session.connectorPublicKey;
```

**Why fall back rather than reject:** during rollout, customers running older connector images must keep working. Once every connector in the fleet is on a version that publishes a pubkey, the controller can flip a per-tenant flag (`require_encrypted_creds: true`) that rejects unencrypted-pubkey registers with a 401-equivalent — but that's a future ops decision, not a v1 protocol requirement.

### C6 — Tests (controller side)

The controller team should add tests covering:
- A register frame with a valid `connectorPublicKey` is captured and used to seal subsequent frames.
- A creds-response sealed with the captured pubkey decrypts correctly under a test fixture's matching private key.
- Mid-session pubkey rotation (reconnect with a new pubkey) re-seals cached values and pushes `creds-update` per MCP.
- Backwards compat: a register frame without `connectorPublicKey` produces cleartext `env` frames.
- Per-org `require_encrypted_creds: true` rejects connectors that didn't supply a pubkey (once that flag is implemented).


## Versioning and rollout

### Protocol version bump

This is a **v1.1** addition under [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md)'s versioning rules: additive fields on existing frames. Backwards-compatible — older controllers ignore the new `connectorPublicKey` field and continue sending cleartext `env`; older connectors don't supply the field and the controller falls back to cleartext. No `protocol-capabilities` handshake needed.

The connector's interpretation of incoming frames is permissive:
- `creds-response` with **only** `env` (older controller) → cleartext path, unchanged behaviour.
- `creds-response` with **only** `encryptedEnv` (newer controller) → decrypt path.
- `creds-response` with **both** (controller in transition / bug) → prefer `encryptedEnv`, log a warn that cleartext was also supplied (operator should chase it down — likely a controller bug leaking creds).

### Rollout phases

**Phase 1 — connector lands E1–E5, publishes pubkey, accepts both shapes.**
- Connector publishes `connectorPublicKey` on every register.
- Connector accepts `encryptedEnv` (decrypts) AND `env` (cleartext fallback).
- No protocol break — works with any controller version.
- Inspector shows ciphertext when present, cleartext when not (visual diagnostic of which controllers are upgraded).

**Phase 2 — controller lands C1–C6.**
- Controller starts sealing values when the session has a pubkey.
- Older connectors keep getting cleartext (no pubkey on their register frame).
- Mixed fleet: some connectors get sealed, some don't, controlled entirely by connector version.

**Phase 3 — fleet-wide observation.**
- Operators check: are all connector pubkeys captured? (controller-side metric).
- Once every active session has a pubkey, flip `require_encrypted_creds: true` per tenant.

**Phase 4 — tighten.**
- Controllers reject `register` frames without `connectorPublicKey` for tenants that have flipped the flag.
- Optional: deprecate the cleartext `env` field on `creds-response` / `creds-update` in a v2 protocol revision (set a sunset date).

This phasing means:
- Customers can roll out at their own pace per connector.
- No coordinated cutover required.
- Controller team can ship C1–C6 independently of any specific connector version.

## Open questions / explicit non-goals

### Open questions for product / security review

1. **Per-org `require_encrypted_creds` flag — when is the right time to enforce?** This is a Phase 3 decision. Should it default to ON for new tenants but OFF for existing ones? Or both off until the operator opts in?
2. **Inspector partial-decrypt visualization.** When one key in an `encryptedEnv` decrypts and another fails (corrupt ciphertext, key fingerprint mismatch), the MCP Status panel needs a state distinct from "all good" and "no creds." Suggested: a yellow border + tooltip `"2/3 keys decrypted"`. Worth a quick design pass.
3. **Compliance documentation.** Once shipped, write a short customer-facing doc: "The connector publishes an ephemeral X25519 public key on each WS connect; the controller seals every credential value with libsodium's `crypto_box_seal` before the frame leaves the WS write buffer; the connector decrypts only inside the supervisor process at the moment of MCP child spawn." That's the audit-friendly summary.
4. **Migration path for the long-tail of customer-authored Type 2 stdio MCPs.** Type 2 stdio MCPs that read `dir/.env` are not affected by this change at all — the controller never sends creds for them. But if a customer wants those creds to flow over the encrypted tunnel, they need to migrate to the controller-vault path (which is a separate plan, see [.claude/plans/MCP-LOADING.md](MCP-LOADING.md) §"No local `.env` for the Twilio bundle (rolling out)"). Worth a note in the migration doc.

### Explicit non-goals

- **Encrypting non-creds frames.** `manifest`, `rpc` payloads, `webhook` payloads, `heartbeat` — none of these are touched. The `manifest` exposes tool schemas (already public via the controller UI), `rpc` is opaque MCP JSON-RPC (already TLS-protected and tool-arg-shaped — encrypting it would obstruct debugging), and `webhook` payloads are inbound HTTP bodies that the customer-side service was going to receive cleartext anyway. Scope is bounded to *credential values*.
- **mTLS on the WS upgrade.** Different threat (impersonation), different fix. Leave as a future work item; documented in [packages/connector/README.md](../../packages/connector/README.md) §"Out of scope (production hardening)".
- **HSM-backed connector private key.** The ephemeral in-memory choice is deliberate. A future high-security tier could support an HSM-backed pubkey published via a different `connectorPublicKey` source (e.g. AWS Nitro Enclave attestation), but the per-process ephemeral path stays the default.
- **Encrypting the connector's stdout/stderr logs.** If a connector's logger ever logs a decrypted value, that's a connector bug — not a wire-format problem. Catch via lint / a logger-side denylist. Out of scope here.
- **Operator key escrow / recovery.** Ephemeral keypair → no recovery story needed. Persistent keypair would have one; we explicitly chose to avoid that complexity.

## Implementation order — who does what when

| Step | Owner | Depends on |
|---|---|---|
| 1. Write this plan, agree threat model | mcp-shim team | — |
| 2. **Inspector cleartext fix (TODO-A)** — render `creds-response.env` values as `<redacted, len=N>` in app.js | mcp-shim team | — (no protocol change; cheap insurance during rollout) |
| 3. Workstream E1 — `mintConnectorKeypair` module + tweetnacl dep | mcp-shim team | — |
| 4. Workstream E2 — pubkey on register frame | mcp-shim team | E1 |
| 5. Workstream E3 — coordinator decrypts | mcp-shim team | E1 |
| 6. Workstream E4 — inspector encryptedEnv rendering | mcp-shim team | E3 |
| 7. Workstream E5 — tests | mcp-shim team | E1–E4 |
| 8. **Cut connector release with E1–E5.** Customer fleet starts publishing pubkeys but still receives cleartext until controller upgrades. | mcp-shim team | E1–E5 |
| 9. Controller team C1–C6 | controller team | independent of #8 — can start as soon as wire format is agreed |
| 10. Controller team rolls out C1–C6 to staging | controller team | #9 |
| 11. Verify staging connectors get `encryptedEnv` | both | #8 + #10 |
| 12. Controller team rolls out to production | controller team | #11 |
| 13. Per-tenant `require_encrypted_creds: true` enforcement | controller team | full fleet on #8 |

Steps 2–7 are a single connector PR. Steps 9–13 are the controller team's separate sprint. The two roadmaps decouple at step 8.

## Rough effort estimate

- **Connector side (E1–E5):** ~1.5 days. Most of the cost is the test suite (E5) and the integration end-to-end fixture. The crypto plumbing itself is small — maybe 60 lines of TypeScript across `connector-keypair.ts` and the coordinator change.
- **Controller side (C1–C6):** ~2–3 days. The cache re-seal logic on reconnect (C3) is the trickiest part; the rest is wrapping the existing `env` build path with a `seal()` call. Test surface is similar in shape.
- **Inspector cosmetic update (E4):** half a day, including a screenshot for the security review.

Total: ~1 sprint week, parallelized.

## Cross-references

- [docs/MCP-PROTOCOL.md](../../docs/MCP-PROTOCOL.md) — wire-format authority. Update v1.1 entries here once the connector lands.
- [packages/connector/src/tunnel/frames.ts](../../packages/connector/src/tunnel/frames.ts) — TS types; add `connectorPublicKey` to `RegisterFrame` and `encryptedEnv` to `CredsResponseFrame` / `CredsUpdateFrame`.
- [packages/connector/src/tunnel/creds-coordinator.ts](../../packages/connector/src/tunnel/creds-coordinator.ts) — decrypt insertion point (E3).
- [packages/connector/src/boot/lifecycle.ts](../../packages/connector/src/boot/lifecycle.ts) — register-frame build site (E2).
- [.claude/plans/MCP-LOADING.md](MCP-LOADING.md) — context for why the controller is the credential vault. This plan extends that one's wire format, doesn't replace it.
- [.claude/plans/TEST-SUITE.md](TEST-SUITE.md) — add catalog rows for E5 tests once written.


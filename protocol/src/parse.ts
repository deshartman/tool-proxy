// Version-aware frame parsing — the "tight" half of decision D7.
//
// The rule (shim plan §2.3):
//   * Same minor as us, or an unknown peer → STRICT. An unknown field or an
//     unknown frame type is rejected. That is what catches drift between two
//     peers that claim the same protocol.
//   * A newer minor of the SAME major → TOLERANT. Unknown fields are stripped,
//     an unknown frame type is ignored. v1.1–v1.4 were all additive; rejecting
//     a newer peer's extra field would force a lockstep upgrade for every
//     additive change.
//   * A different major → refused outright. That is the register-ack's job
//     (see version.ts); a frame from a major we don't speak is never parsed.
//
// parseFrame NEVER throws and NEVER puts field VALUES in its result's error:
// frames carry credentials (creds-response.env, mcp-enable.env) and tool
// arguments (rpc.payload), so an error reports only the frame type and the
// paths of the offending fields.

import { z } from "zod";
import { CONNECTOR_FRAME_SCHEMAS, CONTROLLER_FRAME_SCHEMAS } from "./schemas.js";
import type { ConnectorFrame, ControllerFrame } from "./types.js";
import { PROTOCOL_VERSION, parseVersion, type ProtocolVersion } from "./version.js";

export type Direction = "connector-to-controller" | "controller-to-connector";

export type ParseResult<T> =
  | { ok: true; frame: T }
  // `ignored`: a newer-minor peer sent a frame type we don't know. Not an error.
  | { ok: false; ignored: true; type: string }
  | { ok: false; ignored?: false; type: string | undefined; error: string; issues: string[] };

export interface ParseOptions {
  // The peer's protocol version, once known (from register / register-ack).
  // Absent → treated as our own version, i.e. strict.
  peer?: ProtocolVersion;
  // Our own version. Defaults to the package's PROTOCOL_VERSION; tests override.
  self?: ProtocolVersion;
}

type AnySchema = z.ZodObject<z.ZodRawShape>;

function schemaMap(schemas: readonly AnySchema[]): Map<string, AnySchema> {
  const map = new Map<string, AnySchema>();
  for (const schema of schemas) {
    const literal = (schema.shape as { type: z.ZodLiteral<string> }).type;
    map.set(literal.value, schema);
  }
  return map;
}

const BY_DIRECTION: Record<Direction, Map<string, AnySchema>> = {
  "connector-to-controller": schemaMap(CONNECTOR_FRAME_SCHEMAS as unknown as AnySchema[]),
  "controller-to-connector": schemaMap(CONTROLLER_FRAME_SCHEMAS as unknown as AnySchema[]),
};

// Is the peer on a newer minor of our major? Only then are unknowns tolerated.
function isNewerMinor(self: ProtocolVersion, peer: ProtocolVersion | undefined): boolean {
  return peer !== undefined && peer.major === self.major && peer.minor > self.minor;
}

export function parseFrame(direction: "connector-to-controller", text: string, opts?: ParseOptions): ParseResult<ConnectorFrame>;
export function parseFrame(direction: "controller-to-connector", text: string, opts?: ParseOptions): ParseResult<ControllerFrame>;
export function parseFrame(
  direction: Direction,
  text: string,
  opts: ParseOptions = {},
): ParseResult<ConnectorFrame | ControllerFrame> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, type: undefined, error: "not valid JSON", issues: [] };
  }
  if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
    return { ok: false, type: undefined, error: "frame has no string `type`", issues: [] };
  }
  const type = (raw as { type: string }).type;
  const tolerant = isNewerMinor(opts.self ?? parseVersion(PROTOCOL_VERSION)!, opts.peer);

  const schema = BY_DIRECTION[direction].get(type);
  if (!schema) {
    if (tolerant) return { ok: false, ignored: true, type };
    return { ok: false, type, error: `unknown frame type "${type}" for ${direction}`, issues: [] };
  }

  // Strict rejects unknown keys at every depth; tolerant strips them. Both are
  // applied recursively by deep-wrapping the frame schema.
  const result = (tolerant ? deepStrip(schema) : deepStrict(schema)).safeParse(raw);
  if (result.success) return { ok: true, frame: result.data as ConnectorFrame | ControllerFrame };
  const issues = result.error.issues.map(
    (issue) => `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.code}`,
  );
  return { ok: false, type, error: `invalid "${type}" frame`, issues };
}

// ── deep strictness ─────────────────────────────────────────────────────────
//
// z.object().strict() only applies to its own level. A frame nests objects
// (manifest.servers[].tools[]), and drift hides there as easily as at the top,
// so strictness is pushed through objects, arrays, optionals, unions and
// records. Opaque fields (z.unknown — JSON Schemas, rpc payloads, webhook
// bodies) are deliberately left alone: their contents are not ours to police.

type Mode = "strict" | "strip";
const cache: Record<Mode, WeakMap<z.ZodType, z.ZodType>> = { strict: new WeakMap(), strip: new WeakMap() };

function deep(schema: z.ZodType, mode: Mode): z.ZodType {
  const hit = cache[mode].get(schema);
  if (hit) return hit;
  let out: z.ZodType = schema;
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodType>)) shape[key] = deep(value, mode);
    const obj = z.object(shape);
    out = mode === "strict" ? obj.strict() : obj.strip();
  } else if (schema instanceof z.ZodArray) {
    out = z.array(deep(schema.element as z.ZodType, mode));
  } else if (schema instanceof z.ZodOptional) {
    out = deep(schema.unwrap() as z.ZodType, mode).optional();
  } else if (schema instanceof z.ZodRecord) {
    out = z.record(schema.keyType as z.ZodString, deep(schema.valueType as z.ZodType, mode));
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema.options as z.ZodType[]).map((o) => deep(o, mode));
    out = z.discriminatedUnion(
      (schema as unknown as { _zod: { def: { discriminator: string } } })._zod.def.discriminator,
      options as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
    );
  } else if (schema instanceof z.ZodUnion) {
    out = z.union((schema.options as z.ZodType[]).map((o) => deep(o, mode)) as unknown as [z.ZodType, z.ZodType]);
  }
  cache[mode].set(schema, out);
  return out;
}

const deepStrict = (schema: z.ZodType) => deep(schema, "strict");
const deepStrip = (schema: z.ZodType) => deep(schema, "strip");

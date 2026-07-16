// Channel-value normalization per MEMORY-MCP-INTERFACE.md §4.1. A canonical
// form is what the shim keys on — two identifiers that normalise to the same
// string map to the same identity. Callers pass raw values; we canonicalise
// before matching or storing.

export type Channel =
  | "voice"
  | "sms"
  | "rcs"
  | "mms"
  | "whatsapp"
  | "webchat"
  | "email"
  | "chat"
  | "test-harness";

const PHONE_CHANNELS: ReadonlySet<Channel> = new Set(["voice", "sms", "rcs", "mms", "whatsapp"]);

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

// E.164: leading `+`, 8–15 digits. We strip everything non-digit-or-plus,
// then reject values with too few / too many digits. Values missing `+` but
// with plausible digit counts get one prepended — customer inputs rarely
// carry the `+` prefix, and refusing them is more brittle than helpful for
// a mock. Real production providers should be stricter.
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new NormalizationError("empty phone value");
  const stripped = trimmed.replace(/[^\d+]/g, "");
  const hasPlus = stripped.startsWith("+");
  const digits = stripped.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new NormalizationError(`phone "${raw}" has ${digits.length} digits — E.164 requires 8–15`);
  }
  return hasPlus ? `+${digits}` : `+${digits}`;
}

// Email: lowercase + trim + require exactly one @ with non-empty local and
// domain parts. Enough to catch typos without full RFC 5322 validation.
export function normalizeEmail(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const at = lower.indexOf("@");
  if (at <= 0 || at !== lower.lastIndexOf("@") || at === lower.length - 1) {
    throw new NormalizationError(`email "${raw}" missing single @ or empty part`);
  }
  return lower;
}

// WhatsApp: identifiers often arrive as `whatsapp:+15551234567` (Twilio
// convention). Strip that prefix and normalise as phone.
export function normalizeWhatsapp(raw: string): string {
  const cleaned = raw.trim().replace(/^whatsapp:\s*/i, "");
  return normalizePhone(cleaned);
}

// webchat / chat: trim only — the identifier is opaque (a session UUID, a
// visitor cookie, etc.). Empty values are still invalid.
export function normalizeOpaque(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new NormalizationError("empty opaque identifier");
  return trimmed;
}

export function normalizeChannelValue(channel: Channel, raw: string): string {
  switch (channel) {
    case "email":
      return normalizeEmail(raw);
    case "whatsapp":
      return normalizeWhatsapp(raw);
    case "voice":
    case "sms":
    case "rcs":
    case "mms":
      return normalizePhone(raw);
    case "webchat":
    case "chat":
    case "test-harness":
      return normalizeOpaque(raw);
    default: {
      const exhaustive: never = channel;
      throw new NormalizationError(`unknown channel: ${exhaustive as string}`);
    }
  }
}

export function isPhoneChannel(channel: Channel): boolean {
  return PHONE_CHANNELS.has(channel);
}

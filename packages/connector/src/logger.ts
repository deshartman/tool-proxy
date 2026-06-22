// Single Pino root for the entire connector + any SDK consumer.
//
// Why a custom factory rather than `import pino from 'pino'` everywhere:
// - One root means one transport decision (pretty in TTY, JSON in pipe).
// - `createLogger('component')` produces a child logger with `component`
//   bound on every line, replacing the hand-stamped `[connector]` /
//   `[dispatcher]` / `[<mcp-name>]` prefixes that used to live in format
//   strings.
// - Re-exported from `@mcp-shim/connector/sdk` so customer-authored Type 1
//   MCPs get the same logger by importing the SDK they already depend on.
//
// Output: stdout (Pino default). LOG_LEVEL controls verbosity (Pino
// convention). Pretty-print is auto-enabled when stdout is a TTY or
// NODE_ENV !== 'production' — i.e. interactive dev gets human-readable
// output, the OCI image and `> log.txt` redirects get raw JSON.

import { pino, type Logger, type LoggerOptions } from "pino";
import { envString } from "./env.js";

let root: Logger | undefined;

function shouldPretty(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return Boolean(process.stdout.isTTY);
}

// INSPECTOR-CREDS-VISIBILITY (W-S6): redact known sensitive paths in any
// log object. Belt-and-braces guard against an accidental
// `log.info({env}, ...)` slip — the primary defense is "don't log
// values" (existing code already follows this), and the W-S9 leak tests
// pin every cred-leak channel from the inspector route. This redact list
// is the runtime backstop.
//
// Path syntax is Pino's: dotted accessors with `*` wildcards. We cover:
//   - per-MCP env layers (env, controllerEnv, sessionEnv) at any nesting
//   - the resolved auth headers map and its `authorization` value
//   - common cred-shaped fields by name (token, secret, password, apiKey)
//   - the OAuth2 access_token / client_secret as raw strings
//
// New paths are cheap to add. Don't dilute by adding speculative ones —
// only paths that have actually appeared in a log call (or that we
// deliberately want to forbid future contributors from logging).
const REDACT_PATHS: string[] = [
  "env",
  "*.env",
  "controllerEnv",
  "*.controllerEnv",
  "sessionEnv",
  "*.sessionEnv",
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "spec.headers.authorization",
  "spec.headers.Authorization",
  "auth.value",
  "*.auth.value",
  "auth.bearer",
  "*.auth.bearer",
  "auth.clientSecret",
  "*.auth.clientSecret",
  "access_token",
  "*.access_token",
  "client_secret",
  "*.client_secret",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "authToken",
  "*.authToken",
];

function getRoot(): Logger {
  if (root) return root;
  const opts: LoggerOptions = {
    level: envString("LOG_LEVEL", "info"),
    redact: {
      paths: REDACT_PATHS,
      censor: "[redacted]",
      remove: false,
    },
  };
  if (shouldPretty()) {
    opts.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{component} | {msg}",
      },
    };
  }
  root = pino(opts);
  return root;
}

export function createLogger(component: string): Logger {
  return getRoot().child({ component });
}

export type { Logger } from "pino";

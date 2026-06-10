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

let root: Logger | undefined;

function shouldPretty(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return Boolean(process.stdout.isTTY);
}

function getRoot(): Logger {
  if (root) return root;
  const opts: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
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

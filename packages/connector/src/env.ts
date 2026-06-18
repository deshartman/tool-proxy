// Centralized env-var readers for the connector.
//
// Why this module exists: an admin who writes `FOO=` (blank line) in .env
// expects "leave this unset, use the default". Two surfaces in src/ used
// `??` (nullish coalescing) which treats "" as set — a blank-line override
// then silently flowed through, sometimes harmlessly (Number("")=0=kernel-
// assign), sometimes not (resolve("")=cwd, pino throws on empty level).
//
// The rule across the connector: empty-string env var == not set. Use the
// documented default. The single deliberate exception is the YAML
// `${VAR}` interpolation in config.ts, which substitutes the literal
// empty string and lets the zod schema produce the validation error.
//
// All readers here are pure over an injected env map (default
// `process.env`). Tests should pass a literal map; vi.stubEnv is fine
// when the seam is awkward but the injected-arg shape is preferred.

const isBlank = (v: string | undefined): v is undefined => v === undefined || v === "";

export function envString(
  name: string,
  defaultValue: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[name];
  return isBlank(raw) ? defaultValue : raw;
}

export function envOptional(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[name];
  return isBlank(raw) ? undefined : raw;
}

// Numeric env reader. Empty-or-unset → defaultValue. Set-but-non-numeric
// throws an admin-actionable error naming the var and the bad value rather
// than silently coercing to NaN/0 (the prior `Number("foo")` foot-gun).
export function envNumber(
  name: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (isBlank(raw)) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `${name} must be a number; got ${JSON.stringify(raw)}. Set ${name} to a valid integer or unset it to use the default (${defaultValue}).`,
    );
  }
  return parsed;
}

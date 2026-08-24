import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Helm chart used to gate POSTGRES_URL and CONNECTOR_KEY_FILE behind
// `{{- if eq .Values.connector.credsSource "db" }}`. That switch chose between
// two boot modes; `env` mode was deleted (bootFromEnv + its tests), but the
// chart kept the conditional AND kept exposing credsSource in values.yaml, so
// `helm install --set connector.credsSource=env` rendered a pod missing BOTH
// variables that boot/require-env.ts demands — an immediate CrashLoopBackOff
// from a value the chart still advertised. deploy/helm/README.md even
// documented it as "legacy mode".
//
// These are static checks: helm is not a test dependency, so the templates are
// parsed as text. That is enough for the invariant that matters — the two env
// vars requireEnv() insists on must be rendered UNCONDITIONALLY, so no values
// combination can omit them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHART = join(__dirname, "../../../deploy/helm/mcp-connector");

/** Go-template nesting depth at each line, counting if/range as open. */
function depthAt(text: string, needle: string): number {
  let depth = 0;
  for (const line of text.split("\n")) {
    if (line.includes(needle)) return depth;
    const opens = (line.match(/\{\{-?\s*(if|range|with)\b/g) ?? []).length;
    const closes = (line.match(/\{\{-?\s*end\s*-?\}\}/g) ?? []).length;
    depth += opens - closes;
  }
  return -1; // not found
}

describe("helm chart — the env vars requireEnv() demands are unconditional", () => {
  const secret = readFileSync(join(CHART, "templates/secret.yaml"), "utf8");
  const deployment = readFileSync(join(CHART, "templates/deployment.yaml"), "utf8");

  it("the depth instrument itself works (guards against vacuous passes)", () => {
    // OAUTH_CLIENT_ID is genuinely nested inside the auth if/else chain. If
    // depthAt() reported 0 for it, the two assertions below would pass no
    // matter where their variables sat, and this whole file would be theatre.
    expect(depthAt(secret, "OAUTH_CLIENT_ID:")).toBe(1);
    expect(depthAt(secret, "NO_SUCH_KEY_ANYWHERE")).toBe(-1);
  });

  it("POSTGRES_URL is rendered outside every conditional", () => {
    // It sits after the auth if/else/end chain closes. Inside it, an
    // `auth: oauth2` install would silently drop the database URL.
    expect(secret).toContain("POSTGRES_URL:");
    expect(depthAt(secret, "POSTGRES_URL:"), "POSTGRES_URL must be at template depth 0").toBe(0);
  });

  it("CONNECTOR_KEY_FILE is rendered outside every conditional", () => {
    expect(deployment).toContain("name: CONNECTOR_KEY_FILE");
    expect(depthAt(deployment, "name: CONNECTOR_KEY_FILE"), "CONNECTOR_KEY_FILE must be at template depth 0").toBe(0);
  });

  it("the chart no longer references the removed credsSource value", () => {
    // Includes values.yaml: leaving the key advertised is what made the
    // broken combination reachable in the first place.
    for (const f of ["values.yaml", "templates/secret.yaml", "templates/deployment.yaml", "README.md"]) {
      const text = readFileSync(join(CHART, f), "utf8");
      expect(text, `${f} still mentions credsSource`).not.toMatch(/credsSource/);
    }
  });

  it("no template references CONNECTOR_CREDS_SOURCE", () => {
    for (const text of [secret, deployment]) {
      expect(text).not.toMatch(/CONNECTOR_CREDS_SOURCE/);
    }
  });
});

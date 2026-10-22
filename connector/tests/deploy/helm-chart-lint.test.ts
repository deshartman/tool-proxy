import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// helm is not a test dependency and is not installed in CI, so the chart is
// checked as text. Two classes of defect have actually shipped here, and both
// are invisible to a per-file review:
//
//  1. A required env var rendered INSIDE a conditional. `credsSource` chose
//     between two boot modes; `env` mode was deleted but the chart kept the
//     conditional and kept advertising the value, so
//     `--set connector.credsSource=env` rendered a pod missing the variables
//     boot/require-env.ts demands — CrashLoopBackOff from a value the chart
//     itself offered.
//  2. A `required` naming a value whose PURPOSE was deleted. After ENV-TO-DB
//     and DB-TO-FILE the chart still `required`d secrets.tunnelAuthToken (or
//     three OAUTH_* values) and secrets.postgresUrl, so `helm install` could
//     not succeed at all without supplying credentials the connector would
//     then ignore. Each template was individually valid YAML and valid Go
//     template; nothing local was wrong. Test 2 below is the structural check
//     that catches the whole class.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHART = join(__dirname, "../../../deploy/helm/tool-proxy");

/** Go-template nesting depth at each line, counting if/range/with as open. */
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

const secret = readFileSync(join(CHART, "templates/secret.yaml"), "utf8");
const deployment = readFileSync(join(CHART, "templates/deployment.yaml"), "utf8");
const valuesText = readFileSync(join(CHART, "values.yaml"), "utf8");
const values = parseYaml(valuesText) as Record<string, unknown>;

describe("helm chart — what requireEnv() demands is unconditional", () => {
  it("the depth instrument itself works (guards against vacuous passes)", () => {
    // imagePullSecrets is genuinely nested inside `{{- with .Values.image.pullSecrets }}`.
    // If depthAt() reported 0 for it, every assertion below would pass no
    // matter where its variable sat, and this whole file would be theatre.
    expect(depthAt(deployment, "imagePullSecrets:")).toBe(1);
    expect(depthAt(deployment, "NO_SUCH_KEY_ANYWHERE")).toBe(-1);
  });

  it("CONNECTOR_KEY_FILE is rendered outside every conditional", () => {
    // The ONLY env var requireEnv() demands post-DB-TO-FILE.
    expect(deployment).toContain("name: CONNECTOR_KEY_FILE");
    expect(
      depthAt(deployment, "name: CONNECTOR_KEY_FILE"),
      "CONNECTOR_KEY_FILE must be at template depth 0",
    ).toBe(0);
  });

  it("CONNECTOR_KEY_B64 is rendered outside every conditional", () => {
    // Carries the bytes the entrypoint decodes into the path above. Nested,
    // it would render a Secret with no key for some values combination and
    // the pod would fail opening the sealed store.
    expect(secret).toContain("CONNECTOR_KEY_B64:");
    expect(
      depthAt(secret, "CONNECTOR_KEY_B64:"),
      "CONNECTOR_KEY_B64 must be at template depth 0",
    ).toBe(0);
  });
});

describe("helm chart — every `required` names a value that still exists", () => {
  const templateDir = join(CHART, "templates");
  const templates = readdirSync(templateDir).filter((f) => f.endsWith(".yaml"));

  // Matches `required "<message>" .Values.a.b.c`.
  const RE = /required\s+"(?:[^"\\]|\\.)*"\s+\.Values\.([A-Za-z0-9_.]+)/g;

  const found: { file: string; path: string }[] = [];
  for (const file of templates) {
    const text = readFileSync(join(templateDir, file), "utf8");
    for (const m of text.matchAll(RE)) found.push({ file, path: m[1]! });
  }

  it("finds the required() calls at all (guards against a broken regex)", () => {
    // A regex that silently matched nothing would make the suite below pass
    // on any chart, including one that `required`s six dead values.
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((f) => f.path).sort()).toEqual(["image.tag", "secrets.connectorKeyB64"]);
  });

  it.each(found)("$file requires .Values.$path, which values.yaml declares", ({ path }) => {
    // The key must be PRESENT — its value is normally "" (that is what makes
    // `required` meaningful). An absent key means the chart demands something
    // the operator has no documented way to supply, which is exactly how the
    // retired tunnelAuthToken / postgresUrl requirements survived.
    let node: unknown = values;
    for (const segment of path.split(".")) {
      expect(
        node !== null && typeof node === "object" && segment in (node as object),
        `values.yaml has no key '${path}'`,
      ).toBe(true);
      node = (node as Record<string, unknown>)[segment];
    }
  });
});

describe("helm chart — retired configuration stays retired", () => {
  const chartFiles = ["values.yaml", "templates/secret.yaml", "templates/deployment.yaml", "README.md"];

  it("no template references the removed credsSource value", () => {
    for (const f of chartFiles) {
      const text = readFileSync(join(CHART, f), "utf8");
      expect(text, `${f} still mentions credsSource`).not.toMatch(/credsSource/);
    }
  });

  // Comments are allowed to name a retired var to explain its removal, so
  // assert on the CONFIGURATION only.
  const configOf = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  it.each([
    "TUNNEL_AUTH_TOKEN",
    "OAUTH_CLIENT_ID",
    "OAUTH_CLIENT_SECRET",
    "OAUTH_TOKEN_URL",
    "POSTGRES_URL",
    "CONNECTOR_NAME",
    "CONTROLLER_URL",
  ])("renders no %s env var", (retired) => {
    for (const f of ["templates/secret.yaml", "templates/deployment.yaml"]) {
      const config = configOf(readFileSync(join(CHART, f), "utf8"));
      expect(config, `${f} renders ${retired}`).not.toContain(retired);
    }
  });

  it.each(["tunnelAuthToken", "oauthClientId", "oauthClientSecret", "oauthTokenUrl", "postgresUrl", "connectorKeyFile"])(
    "no longer advertises secrets.%s in values.yaml",
    (key) => {
      // Advertising a dead key is how the broken combination stayed reachable
      // — an operator sets it, helm accepts it, nothing consumes it.
      const declared = (values.secrets ?? {}) as Record<string, unknown>;
      expect(Object.keys(declared)).not.toContain(key);
    },
  );
});

describe("helm chart — resource floor", () => {
  // Measured 493 MB for the connector plus the four bundled demo MCPs: each
  // Type 1 child is three processes (tsx wrapper node, real node, resident
  // esbuild). A 512Mi pod cannot boot the shipped image and the symptom is the
  // fourth child dying at its readiness probe with no output.
  const toMiB = (v: string): number => {
    const m = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)?$/.exec(v.trim());
    if (!m) throw new Error(`unparseable quantity: ${v}`);
    const n = Number(m[1]);
    switch (m[2]) {
      case "Gi": return n * 1024;
      case "G": return (n * 1000 ** 3) / 1024 ** 2;
      case "M": return (n * 1000 ** 2) / 1024 ** 2;
      default: return n; // Mi or bare
    }
  };

  const resources = values.resources as { requests: Record<string, string>; limits: Record<string, string> };

  it("the quantity parser handles the units a chart actually uses", () => {
    expect(toMiB("512Mi")).toBe(512);
    expect(toMiB("1Gi")).toBe(1024);
    expect(toMiB("2Gi")).toBe(2048);
  });

  it("requests at least 1Gi — the request is what the scheduler reserves", () => {
    expect(toMiB(resources.requests.memory!)).toBeGreaterThanOrEqual(1024);
  });

  it("limits at least 1Gi and never below the request", () => {
    expect(toMiB(resources.limits.memory!)).toBeGreaterThanOrEqual(1024);
    expect(toMiB(resources.limits.memory!)).toBeGreaterThanOrEqual(toMiB(resources.requests.memory!));
  });
});

// Stage A. The chart shipped with NO probes at all, so a kubelet had no way to
// tell a connector with an open tunnel from one that had never been configured.
describe("helm chart — orchestrator probes", () => {
  const deployment = readFileSync(join(CHART, "templates/deployment.yaml"), "utf8");

  it("declares both probes against the health port", () => {
    expect(deployment).toMatch(/livenessProbe:[\s\S]*?path: \/livez/);
    expect(deployment).toMatch(/readinessProbe:[\s\S]*?path: \/readyz/);
    expect(deployment).toMatch(/name: health\s+containerPort: 9100/);
    expect(deployment).toMatch(/name: HEALTH_PORT/);
  });

  it("never probes liveness against the tunnel-gated route", () => {
    // /readyz returns 503 whenever the tunnel is down. On liveness that turns
    // one controller outage into every kubelet in the fleet killing its
    // connector at the same moment — precisely when the decorrelated-jitter
    // backoff is trying to spread the herd out.
    // Strip comments before asserting: the block between the two probes
    // includes prose explaining readiness, which legitimately names /readyz.
    const live = deployment
      .slice(deployment.indexOf("livenessProbe:"), deployment.indexOf("readinessProbe:"))
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(live).toContain("/livez");
    expect(live, "liveness must not gate on the tunnel").not.toContain("/readyz");
  });

  it("never probes the inspector port", () => {
    // The inspector binds 127.0.0.1 and refuses non-loopback callers, so a
    // kubelet httpGet against 9090 answers 403 forbidden and the pod never
    // becomes ready. Measured.
    const probes = deployment.slice(deployment.indexOf("livenessProbe:"));
    expect(probes).not.toMatch(/port: 9090|port: inspector/);
  });

  it("gives readiness enough grace for a human to configure the tunnel", () => {
    // A fresh deploy is deliberately not ready: /readyz is 503 until Configure
    // Tunnel is completed via kubectl port-forward. periodSeconds x
    // failureThreshold must leave room for that.
    const ready = deployment.slice(deployment.indexOf("readinessProbe:"));
    const period = Number(/periodSeconds: (\d+)/.exec(ready)?.[1]);
    const threshold = Number(/failureThreshold: (\d+)/.exec(ready)?.[1]);
    expect(period * threshold).toBeGreaterThanOrEqual(120);
  });
});

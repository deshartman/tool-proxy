import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";

import { createMachineApiRouting } from "@connector/boot/machine-api-routing.js";
import { signHs256, verifyAccessToken } from "@connector/auth/jwt.js";
import type { ControllerApiCoordinator } from "@connector/tunnel/controller-api-coordinator.js";
import { createLogger } from "@connector/logger.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// MULTI-PLATFORM-MCP §5.6 / §5.10: "An API client bound to A can't drive B; a
// federated token matching A's issuer can't drive B." Real store, real JWTs —
// self-issued HS256 and federated RS256 against a JWKS served from a test
// keypair. The routing is exercised exactly as the /v1/* routes call it:
// getVerifierConfig(token) → verifyAccessToken → getCoordinator(claims).

const signingKey = Buffer.alloc(32, 7);
const coordinatorA = { tag: "A" } as unknown as ControllerApiCoordinator;
const coordinatorB = { tag: "B" } as unknown as ControllerApiCoordinator;

let fixture: StoreFixture;
let idA: string;
let idB: string;
let routing: ReturnType<typeof createMachineApiRouting>;

// What a /v1/* route does with a bearer: verify against the chosen config,
// then ask for the workspace. Undefined = refused at either step.
async function routeOf(token: string): Promise<string | undefined> {
  const verified = await verifyAccessToken(token, await routing.getVerifierConfig(token));
  if (!verified.valid || !verified.claims) return undefined;
  const c = await routing.getCoordinator(verified.claims);
  return (c as unknown as { tag?: string } | undefined)?.tag;
}

const controller = (name: string) => ({
  name, controllerUrl: `https://${name}.example.com`, connectorName: name, environment: null,
  authMode: "static-bearer" as const, tunnelAuthToken: `ts_${name}`,
});

beforeEach(async () => {
  fixture = await openTempStore();
  idA = (await fixture.store.addController(controller("a"))).id;
  idB = (await fixture.store.addController(controller("b"))).id;
  routing = createMachineApiRouting({
    store: fixture.store,
    signingKey,
    coordinatorOf: (id) => (id === idA ? coordinatorA : id === idB ? coordinatorB : undefined),
    log: createLogger("test-machine-api"),
  });
});
afterEach(async () => { await fixture.cleanup(); });

describe("self-issued tokens route by the client's binding", () => {
  it("a client bound to A drives A, and a client bound to B drives B", async () => {
    const a = await fixture.store.mintApiClient("ca", idA);
    const b = await fixture.store.mintApiClient("cb", idB);
    expect(await routeOf(signHs256({ sub: a.clientId }, signingKey, 60))).toBe("A");
    expect(await routeOf(signHs256({ sub: b.clientId }, signingKey, 60))).toBe("B");
  });

  it("a revoked client drives nothing, even with an unexpired token", async () => {
    const a = await fixture.store.mintApiClient("ca", idA);
    const token = signHs256({ sub: a.clientId }, signingKey, 60);
    await fixture.store.revokeApiClient(a.clientId);
    expect(await routeOf(token)).toBeUndefined();
  });

  it("a client whose controller was removed drives nothing", async () => {
    const a = await fixture.store.mintApiClient("ca", idA);
    await fixture.store.removeController(idA);
    // Still bound to the removed id; that workspace no longer exists.
    expect(await routeOf(signHs256({ sub: a.clientId }, signingKey, 60))).toBeUndefined();
  });

  it("an unknown sub drives nothing", async () => {
    expect(await routeOf(signHs256({ sub: "nobody" }, signingKey, 60))).toBeUndefined();
  });
});

describe("federated tokens route by iss + aud", () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let privateKey: KeyObject;
  const issuer = "https://idp.example.com";

  function signRs256(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ sub: "fed", iss: issuer, iat: now, exp: now + 3600, ...claims })).toString("base64url");
    const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key).toString("base64url");
    return `${header}.${payload}.${sig}`;
  }

  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as object), kid: "k1", use: "sig", alg: "RS256" };
    jwksServer = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", () => r()));
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}/jwks.json`;
  });
  afterAll(async () => { await new Promise<void>((r) => jwksServer.close(() => r())); });

  it("a token for A's audience drives A, never B", async () => {
    await fixture.store.setTrustedIssuerConfig({ issuer, jwksUrl, audience: "aud-a" }, idA);
    await fixture.store.setTrustedIssuerConfig({ issuer, jwksUrl, audience: "aud-b" }, idB);
    expect(await routeOf(signRs256({ aud: "aud-a" }))).toBe("A");
    expect(await routeOf(signRs256({ aud: "aud-b" }))).toBe("B");
  });

  it("an audience no entry trusts drives nothing", async () => {
    await fixture.store.setTrustedIssuerConfig({ issuer, jwksUrl, audience: "aud-a" }, idA);
    expect(await routeOf(signRs256({ aud: "aud-x" }))).toBeUndefined();
  });

  it("forged iss/aud claims cannot reach a workspace — the signature is checked with THAT entry's JWKS", async () => {
    await fixture.store.setTrustedIssuerConfig({ issuer, jwksUrl, audience: "aud-a" }, idA);
    // A token naming A's issuer + audience, signed by a key A's JWKS does not hold.
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(await routeOf(signRs256({ aud: "aud-a" }, attacker))).toBeUndefined();
  });
});

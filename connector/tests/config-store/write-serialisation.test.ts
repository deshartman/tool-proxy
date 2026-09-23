import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import type { ConfigStore, ControllerInput } from "../../src/config-store/index.js";
import { openTempStore, type StoreFixture } from "../helpers/config-store.js";

// Postgres was arbitrating writes for us; the file backend has to do it itself.
// Two in-process writers exist — the inspector's routes, and the frame-router
// persisting a registration token after register-ack — and a whole-file
// read-modify-write can lose one of them.
//
// HONEST NOTE ON WHAT THESE TESTS PROVE. Every mutation body is currently
// synchronous, so a read-modify-write completes within one microtask and the
// "lost update" case cannot be provoked through the public API today, mutex or
// not. These tests therefore pin the observable CONTRACT (concurrent mutations
// all land, in call order) rather than dramatise a race. That still earns its
// place: the moment any mutation gains an await — switching to fs/promises
// would do it — the contract breaks without serialisation, and these fail.
//
// The exception is the last test, which regresses today if the queue's error
// handling is removed.

const baseInput: ControllerInput = {
  name: "original",
  controllerUrl: "https://controller.example.com",
  connectorName: "conn-1",
  environment: "prod",
  authMode: "static-bearer",
  tunnelAuthToken: "bearer-abc",
};

describe("ConfigStore — write serialisation", () => {
  let fixture: StoreFixture;
  let store: ConfigStore;

  beforeEach(async () => {
    fixture = await openTempStore();
    store = fixture.store;
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // The concrete interleaving that matters: the frame-router writing a
  // registration token while the operator submits Configure Tunnel. Neither
  // change may be discarded.
  it("does not lose either of two concurrent mutations", async () => {
    const row = await store.upsertController(baseInput);

    await Promise.all([
      store.updateRegistrationToken(row.id, "reg-token-1"),
      store.upsertController({ ...baseInput, name: "renamed-by-operator" }),
    ]);

    const after = await store.getController();
    expect(after!.name).toBe("renamed-by-operator");
    expect(after!.registrationToken).toBe("reg-token-1");
    // And the bearer the operator did not resupply is still there — the
    // preservation rule the old SQL COALESCE implemented.
    expect(after!.tunnelAuthToken).toBe("bearer-abc");
  });

  it("applies queued mutations in invocation order", async () => {
    await store.upsertController(baseInput);
    const { id } = (await store.getController())!;

    await Promise.all([
      store.updateRegistrationToken(id, "first"),
      store.updateRegistrationToken(id, "second"),
      store.updateRegistrationToken(id, "third"),
    ]);

    expect((await store.getController())!.registrationToken).toBe("third");
  });

  it("keeps a single controller row under concurrent upserts", async () => {
    await Promise.all([
      store.upsertController({ ...baseInput, name: "a" }),
      store.upsertController({ ...baseInput, name: "b" }),
      store.upsertController({ ...baseInput, name: "c" }),
    ]);

    // The `one_controller_only` unique index is gone; the array must not grow.
    const doc = JSON.parse(readFileSync(fixture.path, "utf8"));
    expect(doc.controllers).toHaveLength(1);
  });

  it("persists across a reopen — the restart case", async () => {
    const row = await store.upsertController(baseInput);
    await store.updateRegistrationToken(row.id, "survives-restart");
    const { clientId, clientSecret } = await store.mintApiClient("integration");
    await store.setNetworkAccessEnabled(true);

    const reopened = await fixture.reopen();
    try {
      const after = await reopened.getController();
      expect(after!.registrationToken).toBe("survives-restart");
      expect(after!.tunnelAuthToken).toBe("bearer-abc");
      expect(await reopened.verifyApiClient(clientId, clientSecret)).toBe(true);
      expect(await reopened.getNetworkAccessState()).toEqual({ enabled: true });
    } finally {
      await reopened.close();
    }
  });

  // This one DOES regress today if the queue stops swallowing rejections: one
  // failed mutation would leave `writeQueue` rejected and wedge every write
  // after it, so the connector would silently stop persisting anything.
  //
  // The rejection must originate INSIDE the lock to exercise that. Note which
  // validations do and don't: `name`/`controllerUrl`/`connectorName` are
  // checked before `mutate` is called, so they never reach the queue — an
  // earlier version of this test used a blank name and passed with the error
  // handling removed, proving nothing. The missing-bearer check runs inside the
  // mutation because it needs the prior row to know whether it can preserve one.
  it("keeps accepting writes after a mutation rejects inside the lock", async () => {
    const bad = store.upsertController({ ...baseInput, tunnelAuthToken: undefined });
    await expect(bad).rejects.toThrow(/tunnelAuthToken is required/);

    const row = await store.upsertController(baseInput);
    expect(row.name).toBe("original");
    await store.updateRegistrationToken(row.id, "still-working");
    expect((await store.getController())!.registrationToken).toBe("still-working");
  });

  // A corrupt store must not read as a fresh install: reconfiguring over it
  // would discard a registration token that was still recoverable.
  it("refuses to silently start fresh on a corrupt file", async () => {
    await store.upsertController(baseInput);
    writeFileSync(fixture.path, "{ not json");

    await expect(store.getController()).rejects.toThrow(/not valid JSON/);
    await expect(fixture.reopen()).rejects.toThrow(/not valid JSON/);
  });
});

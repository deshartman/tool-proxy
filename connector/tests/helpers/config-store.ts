// Shared fixture for ConfigStore tests.
//
// Before DB-TO-FILE these five suites each stood up a live Postgres schema and
// threw when POSTGRES_URL was unset — so the suite was red on any machine
// without a database. The store is now a sealed JSON file, so a tmpdir is the
// whole fixture and the tests have no external dependency.
//
// CONNECTOR_STATE_DIR is set on process.env because ConfigStore.open resolves
// its own path (it is called from boot with no arguments). Vitest isolates
// modules per test file, so this does not leak between suites; cleanup()
// restores the prior value regardless.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ConfigStore } from "../../src/config-store/index.js";
import { initSodium } from "../../src/config-store/seal.js";
import type { MasterKey } from "../../src/config-store/master-key.js";

export function makeMasterKey(): MasterKey {
  const bytes = randomBytes(32);
  return { bytes, fingerprint: createHash("sha256").update(bytes).digest("hex") };
}

export interface StoreFixture {
  store: ConfigStore;
  /** The state directory; `config.json` lives directly inside it. */
  dir: string;
  path: string;
  masterKey: MasterKey;
  /**
   * Re-open the same directory — the persistence equivalent of restarting the
   * connector. Pass a different key to assert the fingerprint guard.
   */
  reopen: (key?: MasterKey) => Promise<ConfigStore>;
  cleanup: () => Promise<void>;
}

export async function openTempStore(key: MasterKey = makeMasterKey()): Promise<StoreFixture> {
  await initSodium();
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-store-"));
  const priorStateDir = process.env.CONNECTOR_STATE_DIR;
  process.env.CONNECTOR_STATE_DIR = dir;

  const store = await ConfigStore.open(key);

  return {
    store,
    dir,
    path: join(dir, "config.json"),
    masterKey: key,
    reopen: (nextKey?: MasterKey) => ConfigStore.open(nextKey ?? key),
    cleanup: async () => {
      await store.close();
      if (priorStateDir === undefined) delete process.env.CONNECTOR_STATE_DIR;
      else process.env.CONNECTOR_STATE_DIR = priorStateDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

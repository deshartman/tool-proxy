// Postgres connection pool + boot-time migration runner.
//
// The DSN comes from MOCK_POSTGRES_URL (empty string == unset, same rule
// the connector's envString helper follows). Migrations live in
// ./migrations/*.sql, are applied in filename order, and are tracked in a
// schema_migrations table keyed by filename basename.
//
// This module is the ONLY place in mock-backend/ that talks to Postgres —
// data.ts and calendar.ts import query helpers from here rather than
// opening their own connections.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { pino } from "pino";

const { Pool } = pg;

// LOG_LEVEL="" == unset (MCP-AUDIT #21). pino throws on an empty level, so a
// blank line in the environment stops the service booting — the same guard
// server.ts applies. Note the DSN read below already gets this right (`?.trim()`
// plus an explicit "empty string counts as unset" message); this line did not.
const logLevel = process.env.LOG_LEVEL;
const log = pino({
  level: logLevel === undefined || logLevel === "" ? "info" : logLevel,
}).child({ component: "mock-customers-db" });

const DSN = process.env.MOCK_POSTGRES_URL?.trim();
if (!DSN) {
  throw new Error(
    "MOCK_POSTGRES_URL is required (empty string counts as unset). " +
      "Set it to a Postgres DSN, e.g. postgres://user:pw@host:5432/crm.",
  );
}

// Pool sizing: this service is tiny — one Fly Machine, low QPS. Default pool
// max is 10 clients which is plenty; explicitly setting to keep the intent
// obvious. Idle timeout matches Fly's inbound-idle default so we don't have
// half-closed sockets hanging around.
export const pool = new Pool({
  connectionString: DSN,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  log.error({ err }, "unexpected pool error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as never[] | undefined);
}

// Filename-based migration tracking. Every .sql file under migrations/
// runs once, in filename order (lexicographic — hence the numeric prefixes).
// Idempotent SQL inside each file (IF NOT EXISTS) means a re-run of an
// already-tracked migration is a no-op, but we skip re-runs anyway to keep
// boot fast.
export async function runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );

  let files: string[];
  try {
    files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.warn({ migrationsDir }, "migrations dir not found — skipping");
      return;
    }
    throw err;
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const { rowCount } = await query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );
    if (rowCount && rowCount > 0) {
      log.debug({ version }, "migration already applied");
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    log.info({ version }, "applying migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    log.info({ version }, "migration applied");
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

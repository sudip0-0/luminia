// Migration runner for the Lumina Backend API.
//
// Applies the ordered, numbered SQL files in `packages/api/migrations/` inside
// a transaction per file, tracking applied filenames in a `schema_migrations`
// table so re-runs are idempotent.
//
// Importing this module performs NO I/O and opens NO database connection; the
// build and unit tests can therefore run without a live PostgreSQL instance.
// A connection is established only when `runMigrations` is invoked.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the SQL migrations directory (`packages/api/migrations`). */
export const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/** A single migration file: its ordered name and its SQL contents. */
export interface Migration {
  /** The file name, e.g. `0001_extensions_and_enums.sql`. */
  readonly name: string;
  /** The full SQL text of the migration. */
  readonly sql: string;
}

/** Minimal client surface the runner needs; satisfied by a `pg` PoolClient. */
export interface MigrationClient {
  query(sql: string): Promise<unknown>;
}

const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Returns the migration file names in apply order.
 *
 * Files must match `NNNN_name.sql`; the numeric prefix defines ordering.
 * Throws if two files share the same numeric prefix, which would make the
 * apply order ambiguous.
 */
export function orderMigrationNames(fileNames: readonly string[]): string[] {
  const migrations = fileNames.filter((name) => MIGRATION_FILE_RE.test(name));
  const seen = new Map<string, string>();
  for (const name of migrations) {
    const prefix = name.slice(0, 4);
    const existing = seen.get(prefix);
    if (existing) {
      throw new Error(
        `Duplicate migration prefix ${prefix}: "${existing}" and "${name}"`,
      );
    }
    seen.set(prefix, name);
  }
  return [...migrations].sort((a, b) => a.localeCompare(b));
}

/** Reads and orders every migration from {@link MIGRATIONS_DIR}. */
export async function loadMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<Migration[]> {
  const entries = await readdir(dir);
  const ordered = orderMigrationNames(entries);
  return Promise.all(
    ordered.map(async (name) => ({
      name,
      sql: await readFile(join(dir, name), 'utf8'),
    })),
  );
}

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

/**
 * Applies all not-yet-applied migrations using the given client.
 *
 * The client is expected to be inside a transaction-capable connection; each
 * migration is wrapped in its own `BEGIN`/`COMMIT` so a failure rolls back only
 * the offending file. Returns the names of the migrations that were applied.
 */
export async function applyMigrations(
  client: MigrationClient,
  migrations: readonly Migration[],
): Promise<string[]> {
  await client.query(ENSURE_TABLE_SQL);
  const applied: string[] = [];
  for (const migration of migrations) {
    try {
      await client.query('BEGIN');
      // Skip if already applied (idempotent re-runs).
      const insert = `
        INSERT INTO schema_migrations (name)
        VALUES ('${migration.name.replace(/'/g, "''")}')
        ON CONFLICT (name) DO NOTHING
        RETURNING name;
      `;
      const result = (await client.query(insert)) as { rowCount: number | null };
      if (!result.rowCount) {
        await client.query('COMMIT');
        continue;
      }
      await client.query(migration.sql);
      await client.query('COMMIT');
      applied.push(migration.name);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration "${migration.name}" failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  return applied;
}

/**
 * Connects to PostgreSQL (via `DATABASE_URL` or the provided connection
 * string), applies pending migrations, and closes the connection.
 *
 * `pg` is imported dynamically so this module — and the package build — never
 * require the driver to connect at import time.
 */
export async function runMigrations(
  connectionString: string | undefined = process.env.DATABASE_URL,
): Promise<string[]> {
  if (!connectionString) {
    throw new Error(
      'runMigrations requires a connection string (set DATABASE_URL).',
    );
  }
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const migrations = await loadMigrations();
    return await applyMigrations(client, migrations);
  } finally {
    client?.release();
    await pool.end();
  }
}

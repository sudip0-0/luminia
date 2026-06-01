// CLI entrypoint for applying database migrations.
//
// Usage: `node dist/db/migrate-cli.js` (expects DATABASE_URL in the environment).
// Kept separate from `migrate.ts` so the library functions stay importable
// without triggering a connection or process exit.

import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  try {
    const applied = await runMigrations();
    if (applied.length === 0) {
      console.log('No pending migrations; schema is up to date.');
    } else {
      console.log(`Applied ${applied.length} migration(s):`);
      for (const name of applied) {
        console.log(`  - ${name}`);
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

void main();

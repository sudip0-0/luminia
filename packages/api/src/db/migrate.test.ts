import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  applyMigrations,
  loadMigrations,
  MIGRATIONS_DIR,
  orderMigrationNames,
  type Migration,
  type MigrationClient,
} from './migrate.js';

// A scriptable fake client capturing the SQL issued by the runner, so the
// runner's control flow can be verified without a live PostgreSQL instance.
class FakeClient implements MigrationClient {
  readonly calls: string[] = [];
  /** Filenames considered already applied (their INSERT returns 0 rows). */
  private readonly alreadyApplied: Set<string>;
  /** Filename whose SQL body should throw, to exercise rollback. */
  private readonly failOn?: string;

  constructor(opts: { alreadyApplied?: string[]; failOn?: string } = {}) {
    this.alreadyApplied = new Set(opts.alreadyApplied ?? []);
    this.failOn = opts.failOn;
  }

  query(sql: string): Promise<unknown> {
    this.calls.push(sql);
    if (sql.startsWith('\n        INSERT INTO schema_migrations')) {
      // Determine which migration name is being inserted.
      const match = /VALUES \('(.+?)'\)/.exec(sql);
      const name = match?.[1];
      const rowCount = name && this.alreadyApplied.has(name) ? 0 : 1;
      return Promise.resolve({ rowCount });
    }
    if (this.failOn && sql.includes(this.failOn)) {
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve({ rowCount: 0 });
  }
}

const sampleMigrations: Migration[] = [
  { name: '0001_a.sql', sql: '-- 0001 body create table a;' },
  { name: '0002_b.sql', sql: '-- 0002 body create table b;' },
];

describe('orderMigrationNames', () => {
  it('filters non-migration files and orders by numeric prefix', () => {
    const ordered = orderMigrationNames([
      '0003_c.sql',
      'README.md',
      '0001_a.sql',
      '0002_b.sql',
      'notes.txt',
    ]);
    expect(ordered).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  });

  it('throws on a duplicate numeric prefix', () => {
    expect(() =>
      orderMigrationNames(['0001_a.sql', '0001_b.sql']),
    ).toThrowError(/Duplicate migration prefix 0001/);
  });

  // Property-based check on the ordering helper (input-varying logic).
  // Feature: lumina, Task 2.1: migration ordering is total, sorted, and lossless.
  it('returns a sorted subset containing exactly the valid, unique-prefixed names', () => {
    const validName = fc
      .tuple(
        fc.integer({ min: 0, max: 9999 }),
        fc.stringMatching(/^[a-z0-9_]{1,12}$/),
      )
      .map(([n, suffix]) => `${String(n).padStart(4, '0')}_${suffix}.sql`);

    fc.assert(
      fc.property(
        // Distinct names so a duplicate prefix never makes the helper throw.
        fc.uniqueArray(validName, {
          maxLength: 30,
          selector: (name) => name.slice(0, 4),
        }),
        fc.array(fc.string()),
        (valid, noise) => {
          const ordered = orderMigrationNames([...valid, ...noise]);
          // Sorted ascending.
          expect(ordered).toEqual([...ordered].sort((a, b) => a.localeCompare(b)));
          // Lossless over valid names, and excludes everything else.
          expect(new Set(ordered)).toEqual(new Set(valid));
          // Idempotent.
          expect(orderMigrationNames(ordered)).toEqual(ordered);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('applyMigrations', () => {
  it('ensures the tracking table and applies each pending migration in order', async () => {
    const client = new FakeClient();
    const applied = await applyMigrations(client, sampleMigrations);

    expect(applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(client.calls[0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    // Each applied migration commits its body.
    expect(client.calls).toContain('-- 0001 body create table a;');
    expect(client.calls).toContain('-- 0002 body create table b;');
    expect(client.calls.filter((c) => c === 'BEGIN')).toHaveLength(2);
    expect(client.calls.filter((c) => c === 'COMMIT')).toHaveLength(2);
    expect(client.calls).not.toContain('ROLLBACK');
  });

  it('skips already-applied migrations without running their body', async () => {
    const client = new FakeClient({ alreadyApplied: ['0001_a.sql'] });
    const applied = await applyMigrations(client, sampleMigrations);

    expect(applied).toEqual(['0002_b.sql']);
    expect(client.calls).not.toContain('-- 0001 body create table a;');
    expect(client.calls).toContain('-- 0002 body create table b;');
  });

  it('rolls back and throws when a migration body fails', async () => {
    const client = new FakeClient({ failOn: '0002 body' });
    await expect(applyMigrations(client, sampleMigrations)).rejects.toThrowError(
      /Migration "0002_b.sql" failed/,
    );
    expect(client.calls).toContain('ROLLBACK');
  });
});

describe('migration files on disk', () => {
  it('loads the ordered, numbered SQL files', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const names = migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names[0]).toBe('0001_extensions_and_enums.sql');
    expect(migrations.every((m) => m.sql.length > 0)).toBe(true);
  });

  it('defines every table from the logical schema', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const all = migrations.map((m) => m.sql).join('\n').toLowerCase();
    const tables = [
      '"user"',
      'oauth_identity',
      'refresh_token',
      'topic',
      'user_topic',
      'user_source',
      'article',
      'article_topic',
      'user_embedding',
      'feed_event',
      'saved_article',
      'collection',
      'collection_article',
      'emerging_topic',
      'crawl_state',
      'crawl_failure',
    ];
    for (const table of tables) {
      expect(all).toContain(`create table if not exists ${table}`);
    }
  });

  it('enables pgvector and defines vector(1536) columns plus the url_hash unique constraint', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const all = migrations.map((m) => m.sql).join('\n').toLowerCase();

    expect(all).toContain('create extension if not exists vector');
    // vector(1536) on article.embedding, user_embedding.embedding, topic.centroid.
    expect((all.match(/vector\(1536\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(all).toContain('centroid  vector(1536)');
    expect(all).toContain('embedding            vector(1536)');
    expect(all).toContain('embedding  vector(1536) not null');
    // url_hash UNIQUE constraint.
    expect(all).toContain('constraint article_url_hash_key unique (url_hash)');
  });
});

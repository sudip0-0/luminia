import { describe, it, expect } from 'vitest';
import { fromPool, queryMaybeOne, queryRows } from './queryable.js';
import { FakeQueryable } from './fake-queryable.js';

// Verifies the Queryable abstraction, the pg.Pool adapter, and the small
// query helpers, plus the FakeQueryable used throughout the repository tests.

describe('fromPool', () => {
  it('forwards sql and a mutable params copy to the pool and normalizes the result', async () => {
    const seen: { sql: string; values: unknown[] | undefined }[] = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        seen.push({ sql, values });
        return { rows: [{ id: '1' }], rowCount: 1 };
      },
    };
    const db = fromPool(pool);
    const result = await db.query('SELECT $1', ['a']);
    expect(result).toEqual({ rows: [{ id: '1' }], rowCount: 1 });
    expect(seen[0]?.sql).toBe('SELECT $1');
    expect(seen[0]?.values).toEqual(['a']);
  });

  it('passes undefined values when no params are supplied', async () => {
    let received: unknown;
    const pool = {
      async query(_sql: string, values?: unknown[]) {
        received = values;
        return { rows: [], rowCount: 0 };
      },
    };
    await fromPool(pool).query('SELECT 1');
    expect(received).toBeUndefined();
  });
});

describe('queryRows / queryMaybeOne', () => {
  it('queryRows returns the rows array', async () => {
    const db = new FakeQueryable([{ rows: [{ a: 1 }, { a: 2 }] }]);
    expect(await queryRows(db, 'SELECT a')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('queryMaybeOne returns the first row or null', async () => {
    const empty = new FakeQueryable([{ rows: [] }]);
    expect(await queryMaybeOne(empty, 'SELECT 1')).toBeNull();
    const one = new FakeQueryable([{ rows: [{ a: 1 }] }]);
    expect(await queryMaybeOne(one, 'SELECT 1')).toEqual({ a: 1 });
  });
});

describe('FakeQueryable', () => {
  it('records each call and returns queued results in order', async () => {
    const db = new FakeQueryable([{ rows: [{ n: 1 }] }, { rows: [{ n: 2 }] }]);
    const r1 = await db.query('Q1', [1]);
    const r2 = await db.query('Q2', [2]);
    expect(r1.rows).toEqual([{ n: 1 }]);
    expect(r2.rows).toEqual([{ n: 2 }]);
    expect(db.calls).toEqual([
      { sql: 'Q1', params: [1] },
      { sql: 'Q2', params: [2] },
    ]);
  });

  it('defaults rowCount to the row count and supports a responder', async () => {
    const db = new FakeQueryable((sql) =>
      sql.includes('count') ? { rows: [{ count: '5' }] } : { rows: [] },
    );
    const counted = await db.query('SELECT count(*) AS count');
    expect(counted.rowCount).toBe(1);
    const none = await db.query('SELECT 1');
    expect(none.rowCount).toBe(0);
  });

  it('returns an empty result when the queue is exhausted', async () => {
    const db = new FakeQueryable();
    const result = await db.query('SELECT 1');
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });
});

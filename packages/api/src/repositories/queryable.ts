// The Queryable abstraction over a PostgreSQL connection.
//
// Every repository in this package depends on the narrow {@link Queryable}
// interface rather than on `pg` directly. A live `pg.Pool` (or a pooled
// `PoolClient`) satisfies this interface via {@link fromPool}; unit tests
// supply an in-memory {@link FakeQueryable} (see ./fake-queryable) that records
// the SQL + params it receives and returns canned rows. This keeps the
// repositories fully unit-testable without a live database while staying a thin
// pass-through in production.

import type { Pool, PoolClient } from 'pg';

/** A generic database row keyed by column name. */
export type QueryRow = Record<string, unknown>;

/**
 * The subset of a `pg` query result the repositories rely on. A full
 * `pg.QueryResult` is structurally assignable to this shape.
 */
export interface QueryResultLike<R extends QueryRow = QueryRow> {
  rows: R[];
  /** Number of rows affected; `null` for statements that do not report it. */
  rowCount: number | null;
}

/**
 * Minimal query surface used by every repository. The single `query` method
 * mirrors `pg`'s parameterized form: a SQL string with `$1, $2, …`
 * placeholders and a positional parameter array. Values are NEVER interpolated
 * into the SQL string.
 */
export interface Queryable {
  query<R extends QueryRow = QueryRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

/**
 * Adapt a live `pg` {@link Pool} or {@link PoolClient} to {@link Queryable}.
 * The `pg` driver already accepts `(text, values)` and returns a result whose
 * `rows`/`rowCount` satisfy {@link QueryResultLike}, so this is a thin wrapper
 * that normalizes the optional, readonly parameter array.
 */
export function fromPool(pool: Pick<Pool | PoolClient, 'query'>): Queryable {
  return {
    async query<R extends QueryRow = QueryRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResultLike<R>> {
      const result = await pool.query<R>(
        sql,
        params ? [...params] : undefined,
      );
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

/**
 * Run a query and return its rows. A small convenience over `db.query(...).rows`
 * shared by the repositories.
 */
export async function queryRows<R extends QueryRow = QueryRow>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R[]> {
  const result = await db.query<R>(sql, params);
  return result.rows;
}

/**
 * Run a query expected to return at most one row, returning the first row or
 * `null` when the result set is empty.
 */
export async function queryMaybeOne<R extends QueryRow = QueryRow>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R | null> {
  const result = await db.query<R>(sql, params);
  return result.rows[0] ?? null;
}

// In-memory {@link Queryable} fakes for unit-testing the repositories without a
// live PostgreSQL connection.
//
// {@link FakeQueryable} captures every `(sql, params)` it receives and returns
// canned rows, so tests can assert that a repository builds the correct
// parameterized SQL (placeholders, never interpolated values) and maps the
// returned rows correctly. Two response styles are supported:
//   - a fixed queue of results (one per call, in order), or
//   - a responder function `(sql, params) => result` for call-dependent rows.

import type { QueryResultLike, QueryRow, Queryable } from './queryable.js';

/** A single recorded call to {@link FakeQueryable.query}. */
export interface RecordedQuery {
  sql: string;
  params: readonly unknown[];
}

/** A canned result; `rowCount` defaults to `rows.length` when omitted. */
export interface CannedResult<R extends QueryRow = QueryRow> {
  rows: R[];
  rowCount?: number;
}

type Responder = (
  sql: string,
  params: readonly unknown[],
) => CannedResult | QueryResultLike;

/**
 * A fake {@link Queryable} that records calls and returns canned rows. Construct
 * with either a queue of results (consumed in call order) or a responder.
 */
export class FakeQueryable implements Queryable {
  readonly calls: RecordedQuery[] = [];
  private readonly queue: CannedResult[];
  private readonly responder?: Responder;

  constructor(arg?: CannedResult[] | Responder) {
    if (typeof arg === 'function') {
      this.responder = arg;
      this.queue = [];
    } else {
      this.queue = arg ? [...arg] : [];
    }
  }

  /** The single (or first) recorded call — convenient for one-query tests. */
  get lastCall(): RecordedQuery {
    const call = this.calls.at(-1);
    if (!call) throw new Error('No query has been recorded yet.');
    return call;
  }

  async query<R extends QueryRow = QueryRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.calls.push({ sql, params });
    const result = this.responder
      ? this.responder(sql, params)
      : (this.queue.shift() ?? { rows: [] });
    const rows = (result.rows ?? []) as R[];
    const rowCount =
      'rowCount' in result && result.rowCount !== undefined
        ? result.rowCount
        : rows.length;
    return { rows, rowCount };
  }
}

/** Build a {@link FakeQueryable} that returns the given rows for its first call. */
export function fakeReturning<R extends QueryRow = QueryRow>(
  rows: R[],
): FakeQueryable {
  return new FakeQueryable([{ rows }]);
}

/**
 * Collapse a SQL string's runs of whitespace into single spaces and trim it, so
 * assertions are resilient to formatting/indentation in the repository's SQL.
 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

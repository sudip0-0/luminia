// Crawl bookkeeping repository — typed query functions over `crawl_state` and
// `crawl_failure`.
//
// Drives the "since last successful crawl, else 24h backfill" logic
// (Requirements 5.3, 5.4) and records isolated crawl failures (Requirements
// 5.6, 5.7). All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapCrawlFailure, mapCrawlState } from './rows.js';
import type { Source } from '@lumina/shared';
import type { CrawlFailureRecord, CrawlStateRecord } from './types.js';

const CRAWL_STATE_COLUMNS = `source, last_successful_crawl_at`;
const CRAWL_FAILURE_COLUMNS = `id, source, error, occurred_at`;

/**
 * Read the crawl state for a source, or `null` when no crawl has ever run for
 * it (the signal to use the 24-hour backfill window, Requirement 5.4).
 */
export async function getCrawlState(
  db: Queryable,
  source: Source,
): Promise<CrawlStateRecord | null> {
  const sql = `SELECT ${CRAWL_STATE_COLUMNS} FROM crawl_state WHERE source = $1`;
  const row = await queryMaybeOne(db, sql, [source]);
  return row ? mapCrawlState(row) : null;
}

/**
 * Set a source's last-successful-crawl timestamp, inserting on first run and
 * updating on conflict (the `source` PK). Returns the resulting row
 * (Requirement 5.3).
 */
export async function updateLastSuccessfulCrawl(
  db: Queryable,
  source: Source,
  at: string,
): Promise<CrawlStateRecord> {
  const sql = `
    INSERT INTO crawl_state (source, last_successful_crawl_at)
    VALUES ($1, $2)
    ON CONFLICT (source) DO UPDATE
      SET last_successful_crawl_at = EXCLUDED.last_successful_crawl_at
    RETURNING ${CRAWL_STATE_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [source, at]);
  if (!row) throw new Error('updateLastSuccessfulCrawl did not return a row.');
  return mapCrawlState(row);
}

/**
 * Record an isolated crawl/processing failure (Requirement 5.6). Returns the
 * recorded row.
 */
export async function recordCrawlFailure(
  db: Queryable,
  source: Source,
  error: string,
): Promise<CrawlFailureRecord> {
  const sql = `
    INSERT INTO crawl_failure (source, error)
    VALUES ($1, $2)
    RETURNING ${CRAWL_FAILURE_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [source, error]);
  if (!row) throw new Error('recordCrawlFailure did not return a row.');
  return mapCrawlFailure(row);
}

/** List recent crawl failures for a source, newest-first, capped at `limit`. */
export async function listCrawlFailures(
  db: Queryable,
  source: Source,
  limit = 50,
): Promise<CrawlFailureRecord[]> {
  const sql = `
    SELECT ${CRAWL_FAILURE_COLUMNS} FROM crawl_failure
    WHERE source = $1
    ORDER BY occurred_at DESC, id ASC
    LIMIT $2
  `;
  const rows = await queryRows(db, sql, [source, limit]);
  return rows.map(mapCrawlFailure);
}

// Expo SQLite-backed {@link SignalEventStore} for the durable signal buffer.
//
// All direct `expo-sqlite` access is isolated in this file. The store talks to
// the database only through the small {@link SqliteLike} interface, so the
// query logic here can be exercised against any compatible driver while the
// durable-buffer capacity/eviction/idempotency logic (in `durable-buffer.ts`)
// stays free of any database dependency and is unit-tested with the in-memory
// store.
//
// On-device schema (design "Client Local Storage"):
//   feed_event(client_event_id PK, type, article_id, payload, occurred_at, acknowledged)
// The implicit `rowid` provides a stable FIFO tie-breaker for events that share
// an `occurred_at`, so "oldest" is ordered by (occurred_at ASC, rowid ASC).

import { openDatabaseAsync } from 'expo-sqlite';

import type {
  BufferedFeedEvent,
  SignalEventStore,
} from './types.js';
import type { FeedEventType } from '@lumina/shared';

/** A bindable SQL parameter value used by this store. */
export type SqliteBindValue = string | number | null;

/** Result of a write statement (mirrors `expo-sqlite`'s `SQLiteRunResult`). */
export interface SqliteRunResult {
  lastInsertRowId: number;
  changes: number;
}

/**
 * Minimal abstraction over the Expo SQLite database surface this store needs.
 * `SQLiteDatabase` from `expo-sqlite` satisfies this shape; tests or alternate
 * drivers can provide their own implementation.
 */
export interface SqliteLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqliteBindValue[]): Promise<SqliteRunResult>;
  getAllAsync<T>(source: string, params: SqliteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SqliteBindValue[]): Promise<T | null>;
}

/** Default on-device database file name for the signal buffer. */
export const SIGNAL_DB_NAME = 'lumina-signals.db';

/** Raw row shape as stored in the `feed_event` table. */
interface FeedEventRow {
  client_event_id: string;
  type: string;
  article_id: string | null;
  payload: string;
  occurred_at: string;
  acknowledged: number;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS feed_event (
    client_event_id TEXT PRIMARY KEY NOT NULL,
    type            TEXT NOT NULL,
    article_id      TEXT,
    payload         TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    acknowledged    INTEGER NOT NULL DEFAULT 0
  );
`;

function rowToEvent(row: FeedEventRow): BufferedFeedEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    clientEventId: row.client_event_id,
    type: row.type as FeedEventType,
    articleId: row.article_id,
    payload,
    occurredAt: row.occurred_at,
    acknowledged: row.acknowledged !== 0,
  };
}

/**
 * {@link SignalEventStore} backed by an Expo SQLite database (via the
 * {@link SqliteLike} abstraction). Construct directly with a driver, or use
 * {@link openSignalEventStore} to open the on-device database.
 */
export class SqliteSignalEventStore implements SignalEventStore {
  private constructor(private readonly db: SqliteLike) {}

  /** Create a store and ensure the `feed_event` table exists. */
  static async create(db: SqliteLike): Promise<SqliteSignalEventStore> {
    await db.execAsync(CREATE_TABLE_SQL);
    return new SqliteSignalEventStore(db);
  }

  async insert(event: BufferedFeedEvent): Promise<void> {
    // INSERT OR IGNORE keeps the write idempotent on the client_event_id PK.
    await this.db.runAsync(
      `INSERT OR IGNORE INTO feed_event
         (client_event_id, type, article_id, payload, occurred_at, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.clientEventId,
        event.type,
        event.articleId,
        JSON.stringify(event.payload ?? {}),
        event.occurredAt,
        event.acknowledged ? 1 : 0,
      ],
    );
  }

  async has(clientEventId: string): Promise<boolean> {
    const row = await this.db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM feed_event WHERE client_event_id = ? LIMIT 1`,
      [clientEventId],
    );
    return row !== null;
  }

  async count(): Promise<number> {
    const row = await this.db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM feed_event`,
      [],
    );
    return row?.c ?? 0;
  }

  async deleteOldest(): Promise<string | null> {
    const oldest = await this.db.getFirstAsync<{ client_event_id: string }>(
      `SELECT client_event_id FROM feed_event
       ORDER BY occurred_at ASC, rowid ASC
       LIMIT 1`,
      [],
    );
    if (!oldest) return null;
    await this.db.runAsync(
      `DELETE FROM feed_event WHERE client_event_id = ?`,
      [oldest.client_event_id],
    );
    return oldest.client_event_id;
  }

  async listUnacknowledged(limit?: number): Promise<BufferedFeedEvent[]> {
    const hasLimit = limit !== undefined;
    const sql =
      `SELECT client_event_id, type, article_id, payload, occurred_at, acknowledged
       FROM feed_event
       WHERE acknowledged = 0
       ORDER BY occurred_at ASC, rowid ASC` + (hasLimit ? ` LIMIT ?` : ``);
    const params: SqliteBindValue[] = hasLimit ? [Math.max(0, limit)] : [];
    const rows = await this.db.getAllAsync<FeedEventRow>(sql, params);
    return rows.map(rowToEvent);
  }

  async markAcknowledged(clientEventIds: readonly string[]): Promise<number> {
    if (clientEventIds.length === 0) return 0;
    const placeholders = clientEventIds.map(() => '?').join(', ');
    const result = await this.db.runAsync(
      `UPDATE feed_event
       SET acknowledged = 1
       WHERE acknowledged = 0 AND client_event_id IN (${placeholders})`,
      [...clientEventIds],
    );
    return result.changes;
  }
}

/**
 * Open the on-device signal buffer database and return a ready
 * {@link SqliteSignalEventStore}. This is the only place that touches the
 * real `expo-sqlite` runtime and is therefore not exercised by unit tests.
 */
export async function openSignalEventStore(
  databaseName: string = SIGNAL_DB_NAME,
): Promise<SqliteSignalEventStore> {
  const db = await openDatabaseAsync(databaseName);
  return SqliteSignalEventStore.create(db);
}

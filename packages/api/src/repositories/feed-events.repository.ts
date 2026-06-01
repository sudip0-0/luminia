// Feed-events repository — typed query functions over `feed_event`.
//
// Persists batched behaviour signals idempotently on (user_id, client_event_id)
// (Requirements 13.1, 13.4) and queries events by time window for the
// Preference_Model_Updater and Insights_Service (Requirements 14.2, 24.x). All
// queries are parameterized.

import { type Queryable, queryRows } from './queryable.js';
import { mapFeedEvent } from './rows.js';
import { placeholders } from './mappers.js';
import type { FeedEventRecord, FeedEventWindow, InsertFeedEventInput } from './types.js';

const FEED_EVENT_COLUMNS = `
  id, client_event_id, user_id, article_id, topic_id, type, payload,
  occurred_at, created_at
`;

/**
 * Insert a batch of events for one user, skipping any whose
 * (user_id, client_event_id) already exists via `ON CONFLICT DO NOTHING`
 * (Requirement 13.4 idempotency). Returns only the rows that were newly
 * inserted, so the caller can compute `persisted` vs `duplicates`
 * (Requirement 13.3). A no-op (returns `[]`) for an empty batch.
 */
export async function insertFeedEvents(
  db: Queryable,
  userId: string,
  events: readonly InsertFeedEventInput[],
): Promise<FeedEventRecord[]> {
  if (events.length === 0) return [];
  const params: unknown[] = [userId];
  const valueTuples: string[] = [];
  let i = 2;
  for (const e of events) {
    // ($1=userId, clientEventId, articleId, topicId, type, payload::jsonb, occurredAt)
    valueTuples.push(
      `($1, $${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}::jsonb, $${i + 5})`,
    );
    params.push(
      e.clientEventId,
      e.articleId ?? null,
      e.topicId ?? null,
      e.type,
      JSON.stringify(e.payload ?? {}),
      e.occurredAt,
    );
    i += 6;
  }
  const sql = `
    INSERT INTO feed_event (
      user_id, client_event_id, article_id, topic_id, type, payload, occurred_at
    )
    VALUES ${valueTuples.join(', ')}
    ON CONFLICT (user_id, client_event_id) DO NOTHING
    RETURNING ${FEED_EVENT_COLUMNS}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapFeedEvent);
}

/**
 * Return which of the given client event ids already exist for a user, so the
 * service can report duplicates explicitly (Requirement 13.4). Returns `[]` for
 * an empty input.
 */
export async function findExistingClientEventIds(
  db: Queryable,
  userId: string,
  clientEventIds: readonly string[],
): Promise<string[]> {
  if (clientEventIds.length === 0) return [];
  const sql = `
    SELECT client_event_id FROM feed_event
    WHERE user_id = $1
      AND client_event_id IN (${placeholders(clientEventIds.length, 2)})
  `;
  const rows = await queryRows<{ client_event_id: string }>(db, sql, [
    userId,
    ...clientEventIds,
  ]);
  return rows.map((r) => r.client_event_id);
}

/**
 * Query a user's events within an inclusive-lower, exclusive-upper time window,
 * optionally restricted to a set of event types (Requirement 14.2). Ordered by
 * ascending occurrence time.
 */
export async function listFeedEventsInWindow(
  db: Queryable,
  userId: string,
  window: FeedEventWindow,
): Promise<FeedEventRecord[]> {
  const params: unknown[] = [userId, window.from, window.to];
  let typeClause = '';
  if (window.types && window.types.length > 0) {
    typeClause = `AND type IN (${placeholders(window.types.length, 4)})`;
    params.push(...window.types);
  }
  const sql = `
    SELECT ${FEED_EVENT_COLUMNS} FROM feed_event
    WHERE user_id = $1
      AND occurred_at >= $2
      AND occurred_at < $3
      ${typeClause}
    ORDER BY occurred_at ASC
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapFeedEvent);
}

// User-topics repository — typed query functions over `user_topic`.
//
// Supports onboarding persistence (source/weight, Requirements 3.5, 3.6),
// preference-model topic-weight updates (Requirement 14.6), muting
// (Requirements 25.2-25.5), and the active-tabs/insights weight reads
// (Requirements 8.5, 25.1). All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapUserTopic } from './rows.js';
import type { UpsertUserTopicInput, UserTopicRecord } from './types.js';

const USER_TOPIC_COLUMNS = `
  user_id, topic_id, weight, source, muted, created_at
`;

/**
 * Insert or update a user-topic association. On conflict (the (user, topic) PK)
 * the weight, source, and muted state are updated. Returns the resulting row.
 */
export async function upsertUserTopic(
  db: Queryable,
  userId: string,
  input: UpsertUserTopicInput,
): Promise<UserTopicRecord> {
  const sql = `
    INSERT INTO user_topic (user_id, topic_id, weight, source, muted)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, topic_id) DO UPDATE
      SET weight = EXCLUDED.weight,
          source = EXCLUDED.source,
          muted  = EXCLUDED.muted
    RETURNING ${USER_TOPIC_COLUMNS}
  `;
  const params = [
    userId,
    input.topicId,
    input.weight,
    input.source,
    input.muted ?? false,
  ];
  const row = await queryMaybeOne(db, sql, params);
  if (!row) throw new Error('upsertUserTopic did not return a row.');
  return mapUserTopic(row);
}

/** List all topic associations for a user, ordered by descending weight. */
export async function listUserTopics(
  db: Queryable,
  userId: string,
): Promise<UserTopicRecord[]> {
  const sql = `
    SELECT ${USER_TOPIC_COLUMNS} FROM user_topic
    WHERE user_id = $1
    ORDER BY weight DESC, topic_id ASC
  `;
  const rows = await queryRows(db, sql, [userId]);
  return rows.map(mapUserTopic);
}

/**
 * List a user's non-muted topic tabs with weight strictly greater than 0,
 * ordered by descending weight and capped at `limit` (Requirement 8.5).
 */
export async function listActiveUserTopics(
  db: Queryable,
  userId: string,
  limit = 10,
): Promise<UserTopicRecord[]> {
  const sql = `
    SELECT ${USER_TOPIC_COLUMNS} FROM user_topic
    WHERE user_id = $1 AND weight > 0 AND muted = false
    ORDER BY weight DESC, topic_id ASC
    LIMIT $2
  `;
  const rows = await queryRows(db, sql, [userId, limit]);
  return rows.map(mapUserTopic);
}

/** Find a single user-topic association, or `null` when not associated. */
export async function findUserTopic(
  db: Queryable,
  userId: string,
  topicId: string,
): Promise<UserTopicRecord | null> {
  const sql = `
    SELECT ${USER_TOPIC_COLUMNS} FROM user_topic
    WHERE user_id = $1 AND topic_id = $2
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId]);
  return row ? mapUserTopic(row) : null;
}

/** List the topic ids a user has currently muted. */
export async function listMutedTopicIds(
  db: Queryable,
  userId: string,
): Promise<string[]> {
  const sql = `SELECT topic_id FROM user_topic WHERE user_id = $1 AND muted = true`;
  const rows = await queryRows<{ topic_id: string }>(db, sql, [userId]);
  return rows.map((r) => r.topic_id);
}

/**
 * Set the muted state for an existing user-topic association. Returns the
 * updated row, or `null` when the topic is not associated with the user
 * (Requirement 25.6 — the caller turns `null` into a not-found error). Muting
 * an already-muted topic is idempotent (Requirements 25.4, 25.5).
 */
export async function setUserTopicMuted(
  db: Queryable,
  userId: string,
  topicId: string,
  muted: boolean,
): Promise<UserTopicRecord | null> {
  const sql = `
    UPDATE user_topic SET muted = $3
    WHERE user_id = $1 AND topic_id = $2
    RETURNING ${USER_TOPIC_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId, muted]);
  return row ? mapUserTopic(row) : null;
}

/** Update only a user-topic's weight, clamping is the caller's responsibility. */
export async function setUserTopicWeight(
  db: Queryable,
  userId: string,
  topicId: string,
  weight: number,
): Promise<UserTopicRecord | null> {
  const sql = `
    UPDATE user_topic SET weight = $3
    WHERE user_id = $1 AND topic_id = $2
    RETURNING ${USER_TOPIC_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId, weight]);
  return row ? mapUserTopic(row) : null;
}

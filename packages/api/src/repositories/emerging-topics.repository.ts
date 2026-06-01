// Emerging-topics repository — typed query functions over `emerging_topic`.
//
// The Preference_Model_Updater records detected emerging topics
// (Requirement 14.7); the Insights_Service lists up to 3 not-yet-added topics
// and removes one when the user accepts it (Requirements 24.4, 24.5). All
// queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapEmergingTopic } from './rows.js';
import type { EmergingTopicRecord } from './types.js';

const EMERGING_TOPIC_COLUMNS = `user_id, topic_id, detected_at`;

/**
 * Record a topic as emerging for a user, idempotent on the (user, topic) PK
 * (re-detection refreshes nothing). Returns the row.
 */
export async function recordEmergingTopic(
  db: Queryable,
  userId: string,
  topicId: string,
): Promise<EmergingTopicRecord> {
  const sql = `
    INSERT INTO emerging_topic (user_id, topic_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, topic_id) DO UPDATE
      SET detected_at = emerging_topic.detected_at
    RETURNING ${EMERGING_TOPIC_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId]);
  if (!row) throw new Error('recordEmergingTopic did not return a row.');
  return mapEmergingTopic(row);
}

/**
 * List a user's emerging topics most-recent-first, capped at `limit`
 * (the Insights_Service uses 3, Requirement 24.4).
 */
export async function listEmergingTopics(
  db: Queryable,
  userId: string,
  limit = 3,
): Promise<EmergingTopicRecord[]> {
  const sql = `
    SELECT ${EMERGING_TOPIC_COLUMNS} FROM emerging_topic
    WHERE user_id = $1
    ORDER BY detected_at DESC, topic_id ASC
    LIMIT $2
  `;
  const rows = await queryRows(db, sql, [userId, limit]);
  return rows.map(mapEmergingTopic);
}

/** Find a single emerging-topic detection, or `null`. */
export async function findEmergingTopic(
  db: Queryable,
  userId: string,
  topicId: string,
): Promise<EmergingTopicRecord | null> {
  const sql = `
    SELECT ${EMERGING_TOPIC_COLUMNS} FROM emerging_topic
    WHERE user_id = $1 AND topic_id = $2
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId]);
  return row ? mapEmergingTopic(row) : null;
}

/**
 * Remove an emerging-topic detection (e.g. when the user accepts it,
 * Requirement 24.5). Returns the removed row, or `null` when the user had no
 * such emerging topic (Requirement 24.6 — the caller maps `null` to an error).
 */
export async function deleteEmergingTopic(
  db: Queryable,
  userId: string,
  topicId: string,
): Promise<EmergingTopicRecord | null> {
  const sql = `
    DELETE FROM emerging_topic
    WHERE user_id = $1 AND topic_id = $2
    RETURNING ${EMERGING_TOPIC_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, topicId]);
  return row ? mapEmergingTopic(row) : null;
}

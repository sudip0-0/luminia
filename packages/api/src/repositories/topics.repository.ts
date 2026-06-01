// Topics repository — taxonomy reads over the `topic` table.
//
// Serves the Onboarding_Service taxonomy endpoint (Requirement 3.1) and topic
// lookups used by feed/ingestion. All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapTopic } from './rows.js';
import { placeholders } from './mappers.js';
import type { TopicRecord } from './types.js';

const TOPIC_COLUMNS = `
  id, slug, label, parent_id, color, icon_name, centroid
`;

/** List the full topic taxonomy ordered by slug (Requirement 3.1). */
export async function listTopics(db: Queryable): Promise<TopicRecord[]> {
  const sql = `SELECT ${TOPIC_COLUMNS} FROM topic ORDER BY slug ASC`;
  const rows = await queryRows(db, sql);
  return rows.map(mapTopic);
}

/** Find a topic by id. */
export async function findTopicById(
  db: Queryable,
  id: string,
): Promise<TopicRecord | null> {
  const sql = `SELECT ${TOPIC_COLUMNS} FROM topic WHERE id = $1`;
  const row = await queryMaybeOne(db, sql, [id]);
  return row ? mapTopic(row) : null;
}

/** Find a topic by slug. */
export async function findTopicBySlug(
  db: Queryable,
  slug: string,
): Promise<TopicRecord | null> {
  const sql = `SELECT ${TOPIC_COLUMNS} FROM topic WHERE slug = $1`;
  const row = await queryMaybeOne(db, sql, [slug]);
  return row ? mapTopic(row) : null;
}

/**
 * Resolve a set of topic ids to the rows that exist, used by onboarding to
 * detect unrecognized ids (Requirement 3.3). Returns only the matching rows;
 * the caller compares counts to find unknown ids. Returns `[]` for an empty
 * input without issuing a query.
 */
export async function findTopicsByIds(
  db: Queryable,
  ids: readonly string[],
): Promise<TopicRecord[]> {
  if (ids.length === 0) return [];
  const sql = `
    SELECT ${TOPIC_COLUMNS} FROM topic
    WHERE id IN (${placeholders(ids.length)})
  `;
  const rows = await queryRows(db, sql, ids);
  return rows.map(mapTopic);
}

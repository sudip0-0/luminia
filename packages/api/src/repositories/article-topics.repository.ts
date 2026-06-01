// Article-topics repository — typed query functions over `article_topic`.
//
// Associates an article with its taxonomy topics and a per-association
// confidence (Requirement 7.2), and resolves the highest-confidence topic for
// an article used by mute_topic recording (Requirement 23.4). All queries are
// parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapArticleTopic } from './rows.js';
import { placeholders } from './mappers.js';
import type { ArticleTopicRecord } from './types.js';

const ARTICLE_TOPIC_COLUMNS = `article_id, topic_id, confidence`;

/**
 * Associate an article with a topic at a confidence in [0,1], updating the
 * confidence on conflict (the (article, topic) PK). Returns the resulting row.
 */
export async function associateArticleTopic(
  db: Queryable,
  articleId: string,
  topicId: string,
  confidence: number,
): Promise<ArticleTopicRecord> {
  const sql = `
    INSERT INTO article_topic (article_id, topic_id, confidence)
    VALUES ($1, $2, $3)
    ON CONFLICT (article_id, topic_id) DO UPDATE
      SET confidence = EXCLUDED.confidence
    RETURNING ${ARTICLE_TOPIC_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [articleId, topicId, confidence]);
  if (!row) throw new Error('associateArticleTopic did not return a row.');
  return mapArticleTopic(row);
}

/**
 * Associate many topics with one article in a single multi-row INSERT. Returns
 * the resulting rows. A no-op (returns `[]`) for an empty association list.
 */
export async function associateArticleTopics(
  db: Queryable,
  articleId: string,
  associations: readonly { topicId: string; confidence: number }[],
): Promise<ArticleTopicRecord[]> {
  if (associations.length === 0) return [];
  const params: unknown[] = [articleId];
  const valueTuples: string[] = [];
  let i = 2;
  for (const a of associations) {
    valueTuples.push(`($1, $${i}, $${i + 1})`);
    params.push(a.topicId, a.confidence);
    i += 2;
  }
  const sql = `
    INSERT INTO article_topic (article_id, topic_id, confidence)
    VALUES ${valueTuples.join(', ')}
    ON CONFLICT (article_id, topic_id) DO UPDATE
      SET confidence = EXCLUDED.confidence
    RETURNING ${ARTICLE_TOPIC_COLUMNS}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapArticleTopic);
}

/** List every topic association for an article, ordered by descending confidence. */
export async function listArticleTopics(
  db: Queryable,
  articleId: string,
): Promise<ArticleTopicRecord[]> {
  const sql = `
    SELECT ${ARTICLE_TOPIC_COLUMNS} FROM article_topic
    WHERE article_id = $1
    ORDER BY confidence DESC, topic_id ASC
  `;
  const rows = await queryRows(db, sql, [articleId]);
  return rows.map(mapArticleTopic);
}

/**
 * Resolve the highest-confidence topic association for an article, used to pick
 * the topic targeted by a mute_topic event (Requirement 23.4). Returns `null`
 * when the article has no topic associations. Ties break by topic id for
 * determinism.
 */
export async function findHighestConfidenceTopic(
  db: Queryable,
  articleId: string,
): Promise<ArticleTopicRecord | null> {
  const sql = `
    SELECT ${ARTICLE_TOPIC_COLUMNS} FROM article_topic
    WHERE article_id = $1
    ORDER BY confidence DESC, topic_id ASC
    LIMIT 1
  `;
  const row = await queryMaybeOne(db, sql, [articleId]);
  return row ? mapArticleTopic(row) : null;
}

/** List the topic ids associated with each of the given article ids. */
export async function listTopicIdsForArticles(
  db: Queryable,
  articleIds: readonly string[],
): Promise<ArticleTopicRecord[]> {
  if (articleIds.length === 0) return [];
  const sql = `
    SELECT ${ARTICLE_TOPIC_COLUMNS} FROM article_topic
    WHERE article_id IN (${placeholders(articleIds.length)})
    ORDER BY article_id ASC, confidence DESC
  `;
  const rows = await queryRows(db, sql, articleIds);
  return rows.map(mapArticleTopic);
}

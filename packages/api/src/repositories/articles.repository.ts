// Articles repository — typed query functions over the `article` table.
//
// Supports ingestion storage of complete articles (Requirements 6.5, 7.5),
// deduplication lookups by url_hash (Requirements 6.1, 6.2), detail reads, and
// candidate listing for feed assembly (Requirement 8.x). Embeddings are bound
// as the `pgvector` text literal `[v0,…]`. All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapArticle } from './rows.js';
import { placeholders, serializeVector } from './mappers.js';
import type { ArticleRecord, InsertArticleInput, ListArticleCandidatesFilter } from './types.js';

const ARTICLE_COLUMN_NAMES = [
  'id',
  'url',
  'url_hash',
  'source',
  'title',
  'summary',
  'full_text',
  'embedding',
  'quality_score',
  'difficulty',
  'read_time_minutes',
  'summarization_status',
  'published_at',
  'ingested_at',
] as const;

const ARTICLE_COLUMNS = ARTICLE_COLUMN_NAMES.join(', ');

/** Column list qualified with a table alias, e.g. `a.id, a.url, …`. */
function aliasedArticleColumns(alias: string): string {
  return ARTICLE_COLUMN_NAMES.map((c) => `${alias}.${c}`).join(', ');
}

/**
 * Insert a complete article. The embedding (when present) is serialized to the
 * `pgvector` literal and cast to `vector` in the statement. Returns the stored
 * row.
 */
export async function insertArticle(
  db: Queryable,
  input: InsertArticleInput,
): Promise<ArticleRecord> {
  const sql = `
    INSERT INTO article (
      url, url_hash, source, title, summary, full_text, embedding,
      quality_score, difficulty, read_time_minutes, summarization_status,
      published_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::vector,
      $8, $9, $10, $11, $12
    )
    RETURNING ${ARTICLE_COLUMNS}
  `;
  const params = [
    input.url,
    input.urlHash,
    input.source,
    input.title,
    input.summary ?? null,
    input.fullText ?? null,
    input.embedding ? serializeVector(input.embedding) : null,
    input.qualityScore,
    input.difficulty ?? null,
    input.readTimeMinutes,
    input.summarizationStatus ?? 'pending',
    input.publishedAt,
  ];
  const row = await queryMaybeOne(db, sql, params);
  if (!row) throw new Error('insertArticle did not return a row.');
  return mapArticle(row);
}

/** Find an article by id. */
export async function findArticleById(
  db: Queryable,
  id: string,
): Promise<ArticleRecord | null> {
  const sql = `SELECT ${ARTICLE_COLUMNS} FROM article WHERE id = $1`;
  const row = await queryMaybeOne(db, sql, [id]);
  return row ? mapArticle(row) : null;
}

/**
 * Find an article by its url_hash (the SHA-256 dedup key). Used by the
 * Deduplicator to detect colliding URLs (Requirements 6.1, 6.2).
 */
export async function findArticleByUrlHash(
  db: Queryable,
  urlHash: string,
): Promise<ArticleRecord | null> {
  const sql = `SELECT ${ARTICLE_COLUMNS} FROM article WHERE url_hash = $1`;
  const row = await queryMaybeOne(db, sql, [urlHash]);
  return row ? mapArticle(row) : null;
}

/** Whether an article with the given url_hash already exists (cheap dedup check). */
export async function articleExistsByUrlHash(
  db: Queryable,
  urlHash: string,
): Promise<boolean> {
  const sql = `SELECT 1 FROM article WHERE url_hash = $1 LIMIT 1`;
  const row = await queryMaybeOne(db, sql, [urlHash]);
  return row !== null;
}

/**
 * List candidate articles for feed assembly, applying the optional source,
 * topic, exclusion, and published-after filters conjunctively, ordered by
 * descending recency and capped at `limit` (default 100). Excluded ids and the
 * topic filter are applied via parameterized IN/EXISTS clauses.
 */
export async function listArticleCandidates(
  db: Queryable,
  filter: ListArticleCandidatesFilter = {},
): Promise<ArticleRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filter.source !== undefined) {
    where.push(`a.source = $${i}`);
    params.push(filter.source);
    i += 1;
  }

  if (filter.topicId !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM article_topic at
                WHERE at.article_id = a.id AND at.topic_id = $${i})`,
    );
    params.push(filter.topicId);
    i += 1;
  }

  if (filter.publishedAfter !== undefined) {
    where.push(`a.published_at >= $${i}`);
    params.push(filter.publishedAfter);
    i += 1;
  }

  if (filter.excludeArticleIds && filter.excludeArticleIds.length > 0) {
    where.push(`a.id NOT IN (${placeholders(filter.excludeArticleIds.length, i)})`);
    params.push(...filter.excludeArticleIds);
    i += filter.excludeArticleIds.length;
  }

  const limit = filter.limit ?? 100;
  params.push(limit);
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT ${aliasedArticleColumns('a')} FROM article a
    ${whereClause}
    ORDER BY a.published_at DESC, a.id ASC
    LIMIT $${i}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapArticle);
}

/**
 * Find up to `limit` articles most similar to the given embedding by cosine
 * distance (`pgvector` `<=>`), excluding `excludeArticleId`. Used by related
 * articles (Requirement 11.1) and serendipity centroid queries. The embedding
 * is bound as a `vector` parameter.
 */
export async function findArticlesByEmbeddingSimilarity(
  db: Queryable,
  embedding: readonly number[],
  options: { excludeArticleId?: string; limit?: number } = {},
): Promise<ArticleRecord[]> {
  const params: unknown[] = [serializeVector([...embedding])];
  let i = 2;
  let exclusion = '';
  if (options.excludeArticleId !== undefined) {
    exclusion = `AND a.id <> $${i}`;
    params.push(options.excludeArticleId);
    i += 1;
  }
  params.push(options.limit ?? 5);
  const sql = `
    SELECT ${aliasedArticleColumns('a')} FROM article a
    WHERE a.embedding IS NOT NULL ${exclusion}
    ORDER BY a.embedding <=> $1::vector ASC
    LIMIT $${i}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapArticle);
}

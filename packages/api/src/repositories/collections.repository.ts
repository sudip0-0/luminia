// Collections repository — typed query functions over `collection` and
// `collection_article`.
//
// Supports collection CRUD with ownership scoping, adding saved articles, and
// paginated content listing (Requirements 22.1-22.7). Ownership is enforced in
// the WHERE clause (user_id = $n) so a mutation on another user's collection
// affects no rows and returns `null`, which the service maps to an
// authorization error (Requirement 22.7). All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import {
  mapArticle,
  mapCollection,
  mapCollectionArticle,
} from './rows.js';
import type {
  ArticleRecord,
  CollectionArticleRecord,
  CollectionRecord,
  CreateCollectionInput,
  UpdateCollectionInput,
} from './types.js';

const COLLECTION_COLUMNS = `id, user_id, name, color, icon, created_at`;

/** Create a collection for a user (Requirement 22.1). */
export async function createCollection(
  db: Queryable,
  input: CreateCollectionInput,
): Promise<CollectionRecord> {
  const sql = `
    INSERT INTO collection (user_id, name, color, icon)
    VALUES ($1, $2, $3, $4)
    RETURNING ${COLLECTION_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [
    input.userId,
    input.name,
    input.color,
    input.icon,
  ]);
  if (!row) throw new Error('createCollection did not return a row.');
  return mapCollection(row);
}

/** Find a collection by id, regardless of owner. */
export async function findCollectionById(
  db: Queryable,
  id: string,
): Promise<CollectionRecord | null> {
  const sql = `SELECT ${COLLECTION_COLUMNS} FROM collection WHERE id = $1`;
  const row = await queryMaybeOne(db, sql, [id]);
  return row ? mapCollection(row) : null;
}

/** List a user's collections, most-recent-first. */
export async function listCollections(
  db: Queryable,
  userId: string,
): Promise<CollectionRecord[]> {
  const sql = `
    SELECT ${COLLECTION_COLUMNS} FROM collection
    WHERE user_id = $1
    ORDER BY created_at DESC, id ASC
  `;
  const rows = await queryRows(db, sql, [userId]);
  return rows.map(mapCollection);
}

/**
 * Update a collection scoped to its owner. Only provided fields change. Returns
 * the updated row, or `null` when the collection does not exist OR is not owned
 * by `userId` (Requirement 22.7).
 */
export async function updateCollection(
  db: Queryable,
  userId: string,
  id: string,
  input: UpdateCollectionInput,
): Promise<CollectionRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  const add = (column: string, value: unknown): void => {
    sets.push(`${column} = $${i}`);
    params.push(value);
    i += 1;
  };

  if (input.name !== undefined) add('name', input.name);
  if (input.color !== undefined) add('color', input.color);
  if (input.icon !== undefined) add('icon', input.icon);

  if (sets.length === 0) {
    // Nothing to change; return the owned row when it exists.
    const sql = `
      SELECT ${COLLECTION_COLUMNS} FROM collection
      WHERE id = $1 AND user_id = $2
    `;
    const row = await queryMaybeOne(db, sql, [id, userId]);
    return row ? mapCollection(row) : null;
  }

  params.push(id, userId);
  const sql = `
    UPDATE collection SET ${sets.join(', ')}
    WHERE id = $${i} AND user_id = $${i + 1}
    RETURNING ${COLLECTION_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, params);
  return row ? mapCollection(row) : null;
}

/**
 * Delete a collection scoped to its owner. The `collection_article` rows
 * cascade, but the underlying `saved_article` rows are preserved
 * (Requirement 22.4). Returns the deleted row, or `null` when the collection
 * does not exist or is not owned by `userId` (Requirement 22.7).
 */
export async function deleteCollection(
  db: Queryable,
  userId: string,
  id: string,
): Promise<CollectionRecord | null> {
  const sql = `
    DELETE FROM collection
    WHERE id = $1 AND user_id = $2
    RETURNING ${COLLECTION_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [id, userId]);
  return row ? mapCollection(row) : null;
}

/**
 * Associate an article with a collection, idempotent on the (collection,
 * article) PK. Returns the membership row. The service must verify ownership
 * and that the article is saved before calling (Requirements 22.6, 22.7).
 */
export async function addArticleToCollection(
  db: Queryable,
  collectionId: string,
  articleId: string,
): Promise<CollectionArticleRecord> {
  const sql = `
    INSERT INTO collection_article (collection_id, article_id)
    VALUES ($1, $2)
    ON CONFLICT (collection_id, article_id) DO UPDATE
      SET added_at = collection_article.added_at
    RETURNING collection_id, article_id, added_at
  `;
  const row = await queryMaybeOne(db, sql, [collectionId, articleId]);
  if (!row) throw new Error('addArticleToCollection did not return a row.');
  return mapCollectionArticle(row);
}

/** Remove an article from a collection. Returns the removed row or `null`. */
export async function removeArticleFromCollection(
  db: Queryable,
  collectionId: string,
  articleId: string,
): Promise<CollectionArticleRecord | null> {
  const sql = `
    DELETE FROM collection_article
    WHERE collection_id = $1 AND article_id = $2
    RETURNING collection_id, article_id, added_at
  `;
  const row = await queryMaybeOne(db, sql, [collectionId, articleId]);
  return row ? mapCollectionArticle(row) : null;
}

/**
 * List the articles in a collection, most-recently-added first, paginated by an
 * `added_at` keyset cursor and capped at `limit` (Requirement 22.5).
 */
export async function listCollectionArticles(
  db: Queryable,
  collectionId: string,
  options: { cursorAddedAt?: string; cursorArticleId?: string; limit?: number } = {},
): Promise<ArticleRecord[]> {
  const where: string[] = ['ca.collection_id = $1'];
  const params: unknown[] = [collectionId];
  let i = 2;

  if (options.cursorAddedAt !== undefined) {
    if (options.cursorArticleId !== undefined) {
      where.push(`(ca.added_at, ca.article_id) < ($${i}, $${i + 1})`);
      params.push(options.cursorAddedAt, options.cursorArticleId);
      i += 2;
    } else {
      where.push(`ca.added_at < $${i}`);
      params.push(options.cursorAddedAt);
      i += 1;
    }
  }

  const limit = options.limit ?? 50;
  params.push(limit);
  const sql = `
    SELECT a.id, a.url, a.url_hash, a.source, a.title, a.summary, a.full_text,
           a.embedding, a.quality_score, a.difficulty, a.read_time_minutes,
           a.summarization_status, a.published_at, a.ingested_at
    FROM collection_article ca
    JOIN article a ON a.id = ca.article_id
    WHERE ${where.join(' AND ')}
    ORDER BY ca.added_at DESC, ca.article_id DESC
    LIMIT $${i}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapArticle);
}

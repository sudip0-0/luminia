// Saved-articles repository — typed query functions over `saved_article`.
//
// Supports idempotent save (Requirements 21.1, 21.5), unsave (21.2, 21.6),
// read-state updates (21.3), and filtered, page-bounded listing (21.4). All
// queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapSavedArticle } from './rows.js';
import type { ListSavedArticlesFilter, ReadState, SavedArticleRecord } from './types.js';

const SAVED_ARTICLE_COLUMNS = `user_id, article_id, read_state, saved_at`;

/** Maximum saved-articles returned per page (Requirement 21.4). */
export const SAVED_ARTICLES_PAGE_LIMIT = 50;

/**
 * Save an article idempotently. The (user, article) PK with
 * `ON CONFLICT DO NOTHING` guarantees a re-save leaves the existing row and
 * read state unchanged (Requirement 21.5). Returns `{ record, created }` where
 * `created` is false when the article was already saved, so the service knows
 * whether to record a `save` event.
 */
export async function saveArticle(
  db: Queryable,
  userId: string,
  articleId: string,
): Promise<{ record: SavedArticleRecord; created: boolean }> {
  const insertSql = `
    INSERT INTO saved_article (user_id, article_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, article_id) DO NOTHING
    RETURNING ${SAVED_ARTICLE_COLUMNS}
  `;
  const inserted = await queryMaybeOne(db, insertSql, [userId, articleId]);
  if (inserted) {
    return { record: mapSavedArticle(inserted), created: true };
  }
  // Already saved: fetch and return the existing row unchanged.
  const existing = await findSavedArticle(db, userId, articleId);
  if (!existing) {
    throw new Error('saveArticle conflict but no existing row found.');
  }
  return { record: existing, created: false };
}

/**
 * Remove a saved article. Returns the removed row, or `null` when the article
 * was not saved (Requirement 21.6 — the caller turns `null` into a not-saved
 * error and records no unsave event).
 */
export async function unsaveArticle(
  db: Queryable,
  userId: string,
  articleId: string,
): Promise<SavedArticleRecord | null> {
  const sql = `
    DELETE FROM saved_article
    WHERE user_id = $1 AND article_id = $2
    RETURNING ${SAVED_ARTICLE_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, articleId]);
  return row ? mapSavedArticle(row) : null;
}

/** Find a single saved-article row, or `null` when not saved. */
export async function findSavedArticle(
  db: Queryable,
  userId: string,
  articleId: string,
): Promise<SavedArticleRecord | null> {
  const sql = `
    SELECT ${SAVED_ARTICLE_COLUMNS} FROM saved_article
    WHERE user_id = $1 AND article_id = $2
  `;
  const row = await queryMaybeOne(db, sql, [userId, articleId]);
  return row ? mapSavedArticle(row) : null;
}

/**
 * Set the read state of a saved article to exactly `read` or `unread`
 * (Requirement 21.3). Returns the updated row, or `null` when not saved.
 */
export async function setReadState(
  db: Queryable,
  userId: string,
  articleId: string,
  readState: ReadState,
): Promise<SavedArticleRecord | null> {
  const sql = `
    UPDATE saved_article SET read_state = $3
    WHERE user_id = $1 AND article_id = $2
    RETURNING ${SAVED_ARTICLE_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, articleId, readState]);
  return row ? mapSavedArticle(row) : null;
}

/**
 * List a user's saved articles most-recent-first, filterable by read state and
 * source, paginated by a (saved_at, article_id) keyset cursor and capped at
 * `limit` (default {@link SAVED_ARTICLES_PAGE_LIMIT}, Requirement 21.4). The
 * source filter joins the `article` table. To detect whether a further page
 * exists, the service may request `limit + 1` rows.
 */
export async function listSavedArticles(
  db: Queryable,
  userId: string,
  filter: ListSavedArticlesFilter = {},
): Promise<SavedArticleRecord[]> {
  const where: string[] = ['sa.user_id = $1'];
  const params: unknown[] = [userId];
  let i = 2;

  if (filter.state !== undefined) {
    where.push(`sa.read_state = $${i}`);
    params.push(filter.state);
    i += 1;
  }

  let join = '';
  if (filter.source !== undefined) {
    join = 'JOIN article a ON a.id = sa.article_id';
    where.push(`a.source = $${i}`);
    params.push(filter.source);
    i += 1;
  }

  // Keyset pagination: rows strictly "older" than the cursor, most-recent-first.
  if (filter.cursorSavedAt !== undefined) {
    if (filter.cursorArticleId !== undefined) {
      where.push(
        `(sa.saved_at, sa.article_id) < ($${i}, $${i + 1})`,
      );
      params.push(filter.cursorSavedAt, filter.cursorArticleId);
      i += 2;
    } else {
      where.push(`sa.saved_at < $${i}`);
      params.push(filter.cursorSavedAt);
      i += 1;
    }
  }

  const limit = filter.limit ?? SAVED_ARTICLES_PAGE_LIMIT;
  params.push(limit);
  const sql = `
    SELECT sa.user_id, sa.article_id, sa.read_state, sa.saved_at
    FROM saved_article sa
    ${join}
    WHERE ${where.join(' AND ')}
    ORDER BY sa.saved_at DESC, sa.article_id DESC
    LIMIT $${i}
  `;
  const rows = await queryRows(db, sql, params);
  return rows.map(mapSavedArticle);
}

// Library_Service — collection CRUD with ownership and save-precondition
// enforcement.
//
// Implements the design's Library_Service collections surface
// (Requirements 22.1-22.7):
//   - create a collection owned by the user, validating the name length 1-100
//     (Requirement 22.1)
//   - update a collection's name/color/icon (Requirement 22.3)
//   - delete a collection, removing it and its membership rows while preserving
//     the underlying saved_article rows (Requirement 22.4)
//   - add a saved article to a collection (Requirement 22.2) and reject adding
//     an article the user has not saved with a precondition error that leaves
//     the collection unchanged (Requirement 22.6)
//   - list a collection's contents, paginated most-recently-added first
//     (Requirements 22.2, 22.5)
//   - reject any mutation (and any read) against a collection owned by another
//     user with a uniform authorization (FORBIDDEN) error, leaving the
//     collection unchanged (Requirement 22.7)
//
// Every database concern is reached through the repository layer over the
// narrow {@link Queryable} interface (plus a single keyset-cursor read used by
// the listing), so the service is fully unit-testable with an in-memory
// `FakeQueryable` and never opens a live connection. Ownership is enforced in
// the service by loading the collection first: a collection that does not exist
// yields NOT_FOUND, and one owned by a different user yields FORBIDDEN, so no
// mutation is ever issued against a collection the caller does not own.

import {
  ERROR_CODES,
  makeError,
  validateCollectionName,
  type ApiErrorEnvelope,
  type Paginated,
} from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import { asIso } from '../repositories/mappers.js';
import {
  addArticleToCollection as repoAddArticleToCollection,
  createCollection as repoCreateCollection,
  deleteCollection as repoDeleteCollection,
  findCollectionById,
  listCollectionArticles as repoListCollectionArticles,
  updateCollection as repoUpdateCollection,
} from '../repositories/collections.repository.js';
import { findSavedArticle } from '../repositories/saved-articles.repository.js';
import type {
  ArticleRecord,
  CollectionArticleRecord,
  CollectionRecord,
} from '../repositories/types.js';

/**
 * Maximum articles returned per collection-contents page (Requirement 22.5).
 * Mirrors the saved-articles page limit so library listings stay consistent.
 */
export const COLLECTION_ARTICLES_PAGE_LIMIT = 50;

/**
 * Dependencies for every Library_Service collection operation. The `db` handle
 * is a live `pg` pool in production and a fake in tests.
 */
export interface LibraryCollectionsDeps {
  db: Queryable;
}

/** Fields accepted when creating a collection (Requirement 22.1). */
export interface CreateCollectionInput {
  name: string;
  color: string;
  icon: string;
}

/** Mutable collection fields (Requirement 22.3); omitted fields stay as-is. */
export interface UpdateCollectionPatch {
  name?: string;
  color?: string;
  icon?: string;
}

/** Filters/pagination for the collection-contents listing (Requirement 22.5). */
export interface ListCollectionArticlesQuery {
  cursor?: string;
}

/** Outcome of {@link createCollection}: the new collection or a validation error. */
export type CreateCollectionResult =
  | { ok: true; collection: CollectionRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link updateCollection}: the updated collection, or a validation
 * error (bad name), NOT_FOUND (no such collection), or FORBIDDEN (owned by
 * another user) envelope (Requirements 22.3, 22.7).
 */
export type UpdateCollectionResult =
  | { ok: true; collection: CollectionRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link deleteCollection}: the removed collection, or NOT_FOUND /
 * FORBIDDEN (Requirements 22.4, 22.7).
 */
export type DeleteCollectionResult =
  | { ok: true; collection: CollectionRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link addArticleToCollection}: the membership row, or a
 * validation error (article not saved), NOT_FOUND, or FORBIDDEN envelope
 * (Requirements 22.2, 22.6, 22.7).
 */
export type AddArticleResult =
  | { ok: true; membership: CollectionArticleRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link listCollectionArticles}: a page of articles capped at
 * {@link COLLECTION_ARTICLES_PAGE_LIMIT} with an opaque next-page cursor, or a
 * validation error (malformed cursor), NOT_FOUND, or FORBIDDEN envelope
 * (Requirements 22.5, 22.7).
 */
export type ListCollectionArticlesResult =
  | { ok: true; results: Paginated<ArticleRecord> }
  | { ok: false; error: ApiErrorEnvelope };

/** The keyset a list cursor encodes: the last row's (addedAt, articleId). */
interface ListCursor {
  addedAt: string;
  articleId: string;
}

/** Encode the keyset of the last returned row into an opaque cursor. */
function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ a: cursor.addedAt, i: cursor.articleId }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode an opaque list cursor back to its keyset. Returns `null` when the
 * cursor is malformed so the caller can reject it with a validation error.
 */
function decodeListCursor(cursor: string): ListCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { a?: unknown }).a === 'string' &&
    typeof (parsed as { i?: unknown }).i === 'string'
  ) {
    const { a, i } = parsed as { a: string; i: string };
    return { addedAt: a, articleId: i };
  }
  return null;
}

/** The uniform "not your collection" authorization error (Requirement 22.7). */
function forbiddenError(): ApiErrorEnvelope {
  return makeError(
    ERROR_CODES.FORBIDDEN,
    'You do not have permission to access this collection.',
  );
}

/** The uniform "no such collection" error. */
function notFoundError(): ApiErrorEnvelope {
  return makeError(ERROR_CODES.NOT_FOUND, 'Collection not found.');
}

/**
 * Load a collection and confirm `userId` owns it. Returns the owned collection,
 * or a NOT_FOUND envelope when it does not exist and a FORBIDDEN envelope when
 * it belongs to another user (Requirement 22.7). No mutation is issued, so a
 * rejected request always leaves the collection unchanged.
 */
async function loadOwned(
  db: Queryable,
  userId: string,
  collectionId: string,
): Promise<
  { ok: true; collection: CollectionRecord } | { ok: false; error: ApiErrorEnvelope }
> {
  const collection = await findCollectionById(db, collectionId);
  if (collection === null) {
    return { ok: false, error: notFoundError() };
  }
  if (collection.userId !== userId) {
    return { ok: false, error: forbiddenError() };
  }
  return { ok: true, collection };
}

/** Build the uniform validation-error envelope for a named field. */
function validationError(message: string, field: string): ApiErrorEnvelope {
  return makeError(ERROR_CODES.VALIDATION_ERROR, message, { field });
}

/**
 * Create a collection owned by the user (Requirement 22.1).
 *
 * The name must be 1-100 characters; an out-of-range name is rejected with a
 * validation error before any database access, so nothing is persisted.
 */
export async function createCollection(
  deps: LibraryCollectionsDeps,
  userId: string,
  input: CreateCollectionInput,
): Promise<CreateCollectionResult> {
  if (!validateCollectionName(input.name)) {
    return {
      ok: false,
      error: validationError(
        'Collection name must be between 1 and 100 characters.',
        'name',
      ),
    };
  }
  const collection = await repoCreateCollection(deps.db, {
    userId,
    name: input.name,
    color: input.color,
    icon: input.icon,
  });
  return { ok: true, collection };
}

/**
 * Update a collection's name/color/icon (Requirement 22.3).
 *
 * A provided name is validated first (so a bad name never touches the
 * database). Ownership is then enforced: a collection owned by another user is
 * rejected with a FORBIDDEN error and left unchanged (Requirement 22.7); a
 * missing collection yields NOT_FOUND. Only the fields present in `patch`
 * change.
 */
export async function updateCollection(
  deps: LibraryCollectionsDeps,
  userId: string,
  collectionId: string,
  patch: UpdateCollectionPatch,
): Promise<UpdateCollectionResult> {
  if (patch.name !== undefined && !validateCollectionName(patch.name)) {
    return {
      ok: false,
      error: validationError(
        'Collection name must be between 1 and 100 characters.',
        'name',
      ),
    };
  }

  const owned = await loadOwned(deps.db, userId, collectionId);
  if (!owned.ok) {
    return owned;
  }

  const updated = await repoUpdateCollection(deps.db, userId, collectionId, patch);
  if (updated === null) {
    // The collection vanished between the ownership check and the update.
    return { ok: false, error: notFoundError() };
  }
  return { ok: true, collection: updated };
}

/**
 * Delete a collection (Requirement 22.4).
 *
 * Ownership is enforced before deletion (Requirement 22.7). Deleting removes
 * the collection and — via the `collection_article` foreign key's
 * `ON DELETE CASCADE` — its membership rows, but the service never touches
 * `saved_article`, so every underlying saved article remains in the user's
 * library (Requirement 22.4).
 */
export async function deleteCollection(
  deps: LibraryCollectionsDeps,
  userId: string,
  collectionId: string,
): Promise<DeleteCollectionResult> {
  const owned = await loadOwned(deps.db, userId, collectionId);
  if (!owned.ok) {
    return owned;
  }

  const removed = await repoDeleteCollection(deps.db, userId, collectionId);
  if (removed === null) {
    return { ok: false, error: notFoundError() };
  }
  return { ok: true, collection: removed };
}

/**
 * Add a saved article to a collection (Requirement 22.2).
 *
 * Ownership is enforced first (Requirement 22.7). The article must already be
 * in the user's library: adding an article the user has not saved is rejected
 * with a "must be saved first" validation error and no membership row is
 * inserted, so the collection is left unchanged (Requirement 22.6). The
 * membership insert is idempotent, so re-adding an article succeeds without a
 * duplicate row.
 */
export async function addArticleToCollection(
  deps: LibraryCollectionsDeps,
  userId: string,
  collectionId: string,
  articleId: string,
): Promise<AddArticleResult> {
  const owned = await loadOwned(deps.db, userId, collectionId);
  if (!owned.ok) {
    return owned;
  }

  const saved = await findSavedArticle(deps.db, userId, articleId);
  if (saved === null) {
    return {
      ok: false,
      error: validationError(
        'Article must be saved to the library before it can be added to a collection.',
        'articleId',
      ),
    };
  }

  const membership = await repoAddArticleToCollection(deps.db, collectionId, articleId);
  return { ok: true, membership };
}

/**
 * List a collection's articles most-recently-added first (Requirement 22.5),
 * paged at most {@link COLLECTION_ARTICLES_PAGE_LIMIT} per page.
 *
 * A malformed cursor is rejected with a validation error before any database
 * access. Ownership is enforced so a collection owned by another user is never
 * read (Requirement 22.7). To decide whether a further page exists without a
 * second round-trip the service fetches one extra row
 * (`COLLECTION_ARTICLES_PAGE_LIMIT + 1`): if it comes back, the page is trimmed
 * to the limit and a `nextCursor` is built from the last returned row's
 * (addedAt, articleId) keyset; otherwise `nextCursor` is null.
 */
export async function listCollectionArticles(
  deps: LibraryCollectionsDeps,
  userId: string,
  collectionId: string,
  query: ListCollectionArticlesQuery = {},
): Promise<ListCollectionArticlesResult> {
  let cursor: ListCursor | null = null;
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    cursor = decodeListCursor(query.cursor);
    if (cursor === null) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_ERROR, 'Invalid pagination cursor.'),
      };
    }
  }

  const owned = await loadOwned(deps.db, userId, collectionId);
  if (!owned.ok) {
    return owned;
  }

  const options: {
    cursorAddedAt?: string;
    cursorArticleId?: string;
    limit: number;
  } = { limit: COLLECTION_ARTICLES_PAGE_LIMIT + 1 };
  if (cursor !== null) {
    options.cursorAddedAt = cursor.addedAt;
    options.cursorArticleId = cursor.articleId;
  }

  const rows = await repoListCollectionArticles(deps.db, collectionId, options);
  const hasMore = rows.length > COLLECTION_ARTICLES_PAGE_LIMIT;
  const items = hasMore ? rows.slice(0, COLLECTION_ARTICLES_PAGE_LIMIT) : rows;
  const last = items.at(-1);

  let nextCursor: string | null = null;
  if (hasMore && last) {
    // The repository returns articles without the membership `added_at` that
    // the keyset cursor needs, so read the boundary row's timestamp directly.
    const addedAt = await membershipAddedAt(deps.db, collectionId, last.id);
    if (addedAt !== null) {
      nextCursor = encodeListCursor({ addedAt, articleId: last.id });
    }
  }

  return { ok: true, results: { items, nextCursor } };
}

/**
 * Read the `added_at` timestamp of a single (collection, article) membership
 * row, used to build the keyset cursor for the next page. Returns `null` when
 * the membership row is absent. Parameterized; never interpolates values.
 */
async function membershipAddedAt(
  db: Queryable,
  collectionId: string,
  articleId: string,
): Promise<string | null> {
  const sql = `
    SELECT added_at FROM collection_article
    WHERE collection_id = $1 AND article_id = $2
  `;
  const result = await db.query(sql, [collectionId, articleId]);
  const row = result.rows[0];
  return row ? asIso(row.added_at) : null;
}

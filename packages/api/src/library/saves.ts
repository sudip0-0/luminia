// Library_Service — saves, unsave, read-state, and saved-articles listing.
//
// Implements the design's Library_Service save/read-state surface
// (Requirements 21.1-21.6):
//   - save adds the article with read state `unread` and records exactly ONE
//     `save` Feed_Event, idempotent on re-save (Requirements 21.1, 21.5)
//   - unsave removes the article and records an `unsave` Feed_Event, erroring
//     with the uniform NOT_FOUND envelope when the article was not saved
//     (Requirements 21.2, 21.6)
//   - read-state updates persist exactly `read` or `unread` (Requirement 21.3)
//   - the saved-articles list returns at most 50 per page, filterable by read
//     state and source, with an opaque next-page cursor (Requirement 21.4)
//
// Every database concern is reached through the repository layer over the
// narrow {@link Queryable} interface, so the service is fully unit-testable
// with an in-memory `FakeQueryable` and never opens a live connection. The
// server-recorded Feed_Events need a `clientEventId` and an occurrence time
// (the Signal_Collector supplies these for client events); both are injected so
// tests stay deterministic and production gets real values by default.

import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
  type LibraryQuery,
  type Paginated,
} from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import {
  SAVED_ARTICLES_PAGE_LIMIT,
  listSavedArticles,
  saveArticle as repoSaveArticle,
  setReadState as repoSetReadState,
  unsaveArticle as repoUnsaveArticle,
} from '../repositories/saved-articles.repository.js';
import { insertFeedEvents } from '../repositories/feed-events.repository.js';
import type {
  ListSavedArticlesFilter,
  ReadState,
  SavedArticleRecord,
} from '../repositories/types.js';

/**
 * Maximum saved articles returned per library page (Requirement 21.4). Mirrors
 * the repository's page limit so the two never drift apart.
 */
export const LIBRARY_PAGE_LIMIT = SAVED_ARTICLES_PAGE_LIMIT;

/**
 * Dependencies for every Library_Service save operation. The `db` handle is the
 * only required dependency; `newEventId` and `now` are injected so the
 * server-recorded `save`/`unsave` Feed_Events are deterministic under test
 * while defaulting to real values in production.
 */
export interface LibrarySavesDeps {
  /** The database handle (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
  /** Generates the `clientEventId` for a server-recorded Feed_Event. */
  newEventId?: () => string;
  /** Supplies the occurrence time for a server-recorded Feed_Event. */
  now?: () => Date;
}

/**
 * Outcome of {@link saveArticle}. Saving always succeeds (it is idempotent), so
 * there is no error variant; `created` is true only on the first save of an
 * article, i.e. exactly when a `save` Feed_Event was recorded
 * (Requirements 21.1, 21.5).
 */
export interface SaveResult {
  record: SavedArticleRecord;
  /** True when a new row was created and a `save` event recorded. */
  created: boolean;
}

/**
 * Outcome of {@link unsaveArticle}: the removed row, or the uniform NOT_FOUND
 * envelope when the article was not saved (Requirement 21.6).
 */
export type UnsaveResult =
  | { ok: true; record: SavedArticleRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link setReadState}: the updated row, or the uniform NOT_FOUND
 * envelope when the article is not in the user's library.
 */
export type SetReadStateResult =
  | { ok: true; record: SavedArticleRecord }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Outcome of {@link listSaved}: a page of saved articles capped at
 * {@link LIBRARY_PAGE_LIMIT} with an opaque next-page cursor, or a validation
 * error when the supplied cursor is malformed.
 */
export type ListSavedResult =
  | { ok: true; results: Paginated<SavedArticleRecord> }
  | { ok: false; error: ApiErrorEnvelope };

/** The keyset a list cursor encodes: the last row's (savedAt, articleId). */
interface ListCursor {
  savedAt: string;
  articleId: string;
}

/** Encode the keyset of the last returned row into an opaque cursor. */
function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ s: cursor.savedAt, a: cursor.articleId }),
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
    typeof (parsed as { s?: unknown }).s === 'string' &&
    typeof (parsed as { a?: unknown }).a === 'string'
  ) {
    const { s, a } = parsed as { s: string; a: string };
    return { savedAt: s, articleId: a };
  }
  return null;
}

/** Resolve the injected `newEventId`, defaulting to a random UUID. */
function nextEventId(deps: LibrarySavesDeps): string {
  return (deps.newEventId ?? randomUUID)();
}

/** Resolve the injected occurrence time, defaulting to the current instant. */
function occurredAt(deps: LibrarySavesDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

/**
 * Save an article to the user's library (Requirements 21.1, 21.5).
 *
 * The save itself is idempotent at the data layer: the repository's
 * `ON CONFLICT DO NOTHING` insert leaves an already-saved row (and its read
 * state) untouched and reports `created = false`. This service records a `save`
 * Feed_Event ONLY when a new row was created, so a first save records exactly
 * one event and any re-save records none — no duplicate row, no duplicate
 * event. New rows always start with read state `unread` (enforced by the
 * `saved_article.read_state` column default).
 */
export async function saveArticle(
  deps: LibrarySavesDeps,
  userId: string,
  articleId: string,
): Promise<SaveResult> {
  const { record, created } = await repoSaveArticle(deps.db, userId, articleId);
  if (created) {
    await insertFeedEvents(deps.db, userId, [
      {
        clientEventId: nextEventId(deps),
        articleId,
        type: 'save',
        occurredAt: occurredAt(deps),
      },
    ]);
  }
  return { record, created };
}

/**
 * Remove an article from the user's library (Requirements 21.2, 21.6).
 *
 * When the article was saved the repository deletes and returns the row, and
 * this service records an `unsave` Feed_Event. When the article was not saved
 * the repository returns `null`; the service then rejects with the uniform
 * NOT_FOUND envelope and records no `unsave` event.
 */
export async function unsaveArticle(
  deps: LibrarySavesDeps,
  userId: string,
  articleId: string,
): Promise<UnsaveResult> {
  const removed = await repoUnsaveArticle(deps.db, userId, articleId);
  if (removed === null) {
    return {
      ok: false,
      error: makeError(
        ERROR_CODES.NOT_FOUND,
        'Article is not saved in the library.',
      ),
    };
  }
  await insertFeedEvents(deps.db, userId, [
    {
      clientEventId: nextEventId(deps),
      articleId,
      type: 'unsave',
      occurredAt: occurredAt(deps),
    },
  ]);
  return { ok: true, record: removed };
}

/**
 * Persist the read state of a saved article as exactly `read` or `unread`
 * (Requirement 21.3). Returns NOT_FOUND when the article is not in the user's
 * library so the read state of an unsaved article can never be set.
 */
export async function setReadState(
  deps: LibrarySavesDeps,
  userId: string,
  articleId: string,
  state: ReadState,
): Promise<SetReadStateResult> {
  const updated = await repoSetReadState(deps.db, userId, articleId, state);
  if (updated === null) {
    return {
      ok: false,
      error: makeError(
        ERROR_CODES.NOT_FOUND,
        'Article is not saved in the library.',
      ),
    };
  }
  return { ok: true, record: updated };
}

/**
 * List the user's saved articles most-recent-first (Requirement 21.4),
 * filterable by read state and source and paged at most
 * {@link LIBRARY_PAGE_LIMIT} per page.
 *
 * To decide whether a further page exists without a second round-trip, the
 * service fetches one extra row (`LIBRARY_PAGE_LIMIT + 1`): if it comes back,
 * the page is trimmed to the limit and a `nextCursor` is built from the last
 * returned row's (savedAt, articleId) keyset; otherwise `nextCursor` is null. A
 * malformed cursor is rejected with the uniform validation envelope.
 */
export async function listSaved(
  deps: LibrarySavesDeps,
  userId: string,
  query: LibraryQuery = {},
): Promise<ListSavedResult> {
  const filter: ListSavedArticlesFilter = { limit: LIBRARY_PAGE_LIMIT + 1 };
  if (query.state !== undefined) {
    filter.state = query.state;
  }
  if (query.source !== undefined) {
    filter.source = query.source;
  }
  if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
    const decoded = decodeListCursor(query.cursor);
    if (decoded === null) {
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION_ERROR, 'Invalid pagination cursor.'),
      };
    }
    filter.cursorSavedAt = decoded.savedAt;
    filter.cursorArticleId = decoded.articleId;
  }

  const rows = await listSavedArticles(deps.db, userId, filter);
  const hasMore = rows.length > LIBRARY_PAGE_LIMIT;
  const items = hasMore ? rows.slice(0, LIBRARY_PAGE_LIMIT) : rows;
  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeListCursor({ savedAt: last.savedAt, articleId: last.articleId })
      : null;

  return { ok: true, results: { items, nextCursor } };
}

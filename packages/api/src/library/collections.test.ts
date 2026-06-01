import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import {
  COLLECTION_ARTICLES_PAGE_LIMIT,
  addArticleToCollection,
  createCollection,
  deleteCollection,
  listCollectionArticles,
  updateCollection,
  type LibraryCollectionsDeps,
} from './collections.js';

// Verifies the Library_Service collections surface against an in-memory
// FakeQueryable: create with valid/invalid name (Requirement 22.1), update and
// delete on own vs another user's collection (FORBIDDEN, Requirement 22.7),
// adding a saved vs unsaved article (precondition rejection, Requirement 22.6),
// delete preserving the underlying saved articles (only collection/membership
// removed, Requirement 22.4), and paginated contents (Requirement 22.5).

const OWNER = 'u-1';
const OTHER = 'u-2';

/** A collection row as the DB returns it (snake_case). */
function collectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    user_id: OWNER,
    name: 'Reading',
    color: '#fff',
    icon: 'book',
    created_at: new Date('2024-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A saved_article row as the DB returns it. */
function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: OWNER,
    article_id: 'art-1',
    read_state: 'unread',
    saved_at: new Date('2024-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A complete article row as the contents join returns it. */
function articleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'art-1',
    url: 'https://example.com/a',
    url_hash: 'a'.repeat(64),
    source: 'wikipedia',
    title: 'Title',
    summary: 'Summary.',
    full_text: 'Body.',
    embedding: null,
    quality_score: '0.8',
    difficulty: 'intermediate',
    read_time_minutes: 7,
    summarization_status: 'summarized',
    published_at: new Date('2024-01-15T12:00:00.000Z'),
    ingested_at: new Date('2024-01-15T13:00:00.000Z'),
    ...overrides,
  };
}

/** A collection_article membership row. */
function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    collection_id: 'c-1',
    article_id: 'art-1',
    added_at: new Date('2024-05-02T00:00:00.000Z'),
    ...overrides,
  };
}

function deps(db: FakeQueryable): LibraryCollectionsDeps {
  return { db };
}

/** Count recorded mutations of a given kind. */
function deletesAgainst(db: FakeQueryable, table: string) {
  return db.calls.filter((c) =>
    new RegExp(`DELETE FROM ${table}\\b`, 'i').test(c.sql),
  );
}

describe('createCollection', () => {
  it('creates a collection owned by the user with a valid name', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);

    const result = await createCollection(deps(db), OWNER, {
      name: 'Reading',
      color: '#fff',
      icon: 'book',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collection.userId).toBe(OWNER);
      expect(result.collection.name).toBe('Reading');
    }
    // The owner is bound as the first INSERT param.
    expect(db.lastCall.params[0]).toBe(OWNER);
  });

  it('accepts boundary name lengths 1 and 100', async () => {
    for (const name of ['a', 'a'.repeat(100)]) {
      const db = new FakeQueryable([{ rows: [collectionRow({ name })] }]);
      const result = await createCollection(deps(db), OWNER, {
        name,
        color: '#fff',
        icon: 'book',
      });
      expect(result.ok).toBe(true);
    }
  });

  it('rejects an empty or over-length name with a validation error and no DB write', async () => {
    for (const name of ['', 'a'.repeat(101)]) {
      const db = new FakeQueryable([{ rows: [collectionRow()] }]);
      const result = await createCollection(deps(db), OWNER, {
        name,
        color: '#fff',
        icon: 'book',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      }
      // Validation precedes any DB access (Requirement 22.1).
      expect(db.calls).toHaveLength(0);
    }
  });
});

describe('updateCollection', () => {
  it('updates the fields of the user own collection', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows: [collectionRow({ name: 'New' })] }, // UPDATE ... RETURNING
    ]);

    const result = await updateCollection(deps(db), OWNER, 'c-1', { name: 'New' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collection.name).toBe('New');
    }
  });

  it('rejects updating another user collection with FORBIDDEN and issues no update', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow({ user_id: OTHER })] }, // owned by someone else
    ]);

    const result = await updateCollection(deps(db), OWNER, 'c-1', { name: 'New' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.FORBIDDEN);
    }
    // Only the ownership SELECT ran; no UPDATE was issued (collection unchanged).
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain('SELECT');
  });

  it('returns NOT_FOUND for a missing collection', async () => {
    const db = new FakeQueryable([{ rows: [] }]);

    const result = await updateCollection(deps(db), OWNER, 'missing', { color: '#000' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });

  it('rejects an invalid name before any DB access', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);

    const result = await updateCollection(deps(db), OWNER, 'c-1', { name: 'a'.repeat(101) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(db.calls).toHaveLength(0);
  });
});

describe('deleteCollection', () => {
  it('deletes the user own collection and preserves the underlying saved articles', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows: [collectionRow()] }, // DELETE FROM collection ... RETURNING
    ]);

    const result = await deleteCollection(deps(db), OWNER, 'c-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collection.id).toBe('c-1');
    }
    // Exactly one DELETE, and it targets the collection only — never
    // saved_article — so the underlying saved articles are retained (22.4).
    expect(deletesAgainst(db, 'collection')).toHaveLength(1);
    expect(deletesAgainst(db, 'saved_article')).toHaveLength(0);
  });

  it('rejects deleting another user collection with FORBIDDEN and issues no delete', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow({ user_id: OTHER })] },
    ]);

    const result = await deleteCollection(deps(db), OWNER, 'c-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.FORBIDDEN);
    }
    // Nothing was deleted (collection left unchanged, Requirement 22.7).
    expect(deletesAgainst(db, 'collection')).toHaveLength(0);
    expect(deletesAgainst(db, 'saved_article')).toHaveLength(0);
  });
});

describe('addArticleToCollection', () => {
  it('adds an article the user has saved', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows: [savedRow()] }, // findSavedArticle -> saved
      { rows: [membershipRow()] }, // INSERT membership ... RETURNING
    ]);

    const result = await addArticleToCollection(deps(db), OWNER, 'c-1', 'art-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.membership.collectionId).toBe('c-1');
      expect(result.membership.articleId).toBe('art-1');
    }
  });

  it('rejects adding an unsaved article with a precondition error and leaves the collection unchanged', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows: [] }, // findSavedArticle -> not saved
    ]);

    const result = await addArticleToCollection(deps(db), OWNER, 'c-1', 'art-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    // No membership INSERT was issued; only the ownership + save checks ran.
    expect(db.calls).toHaveLength(2);
    expect(
      db.calls.some((c) => /INSERT INTO collection_article/i.test(c.sql)),
    ).toBe(false);
  });

  it('rejects adding to another user collection with FORBIDDEN before the save check', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow({ user_id: OTHER })] },
    ]);

    const result = await addArticleToCollection(deps(db), OWNER, 'c-1', 'art-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.FORBIDDEN);
    }
    // Stops at the ownership check: no save lookup, no membership insert.
    expect(db.calls).toHaveLength(1);
  });
});

describe('listCollectionArticles', () => {
  it('returns the contents with no next cursor when fewer than a full page exist', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows: [articleRow(), articleRow({ id: 'art-2' })] }, // contents
    ]);

    const result = await listCollectionArticles(deps(db), OWNER, 'c-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toHaveLength(2);
      expect(result.results.nextCursor).toBeNull();
    }
  });

  it('caps a page at the limit and emits a next cursor when more rows exist', async () => {
    const rows = Array.from({ length: COLLECTION_ARTICLES_PAGE_LIMIT + 1 }, (_, n) =>
      articleRow({ id: `art-${n}` }),
    );
    const db = new FakeQueryable([
      { rows: [collectionRow()] }, // ownership load
      { rows }, // contents: limit + 1 rows
      { rows: [membershipRow({ article_id: `art-${COLLECTION_ARTICLES_PAGE_LIMIT - 1}` })] }, // boundary added_at
    ]);

    const result = await listCollectionArticles(deps(db), OWNER, 'c-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toHaveLength(COLLECTION_ARTICLES_PAGE_LIMIT);
      expect(result.results.nextCursor).not.toBeNull();
    }
    // The repository was asked for LIMIT + 1 rows (keyset over-fetch).
    const contentsCall = db.calls[1];
    expect(contentsCall?.params.at(-1)).toBe(COLLECTION_ARTICLES_PAGE_LIMIT + 1);
  });

  it('round-trips its own next cursor into the keyset filter on the next page', async () => {
    const rows = Array.from({ length: COLLECTION_ARTICLES_PAGE_LIMIT + 1 }, (_, n) =>
      articleRow({ id: `art-${n}` }),
    );
    const db1 = new FakeQueryable([
      { rows: [collectionRow()] },
      { rows },
      { rows: [membershipRow({ article_id: `art-${COLLECTION_ARTICLES_PAGE_LIMIT - 1}` })] },
    ]);
    const page1 = await listCollectionArticles(deps(db1), OWNER, 'c-1');
    const cursor = page1.ok ? page1.results.nextCursor : null;
    expect(cursor).not.toBeNull();

    const db2 = new FakeQueryable([
      { rows: [collectionRow()] },
      { rows: [] },
    ]);
    await listCollectionArticles(deps(db2), OWNER, 'c-1', { cursor: cursor ?? undefined });
    const contentsCall = db2.calls[1];
    expect(contentsCall?.sql).toContain('(ca.added_at, ca.article_id) < ($2, $3)');
  });

  it('rejects a malformed cursor with a validation error and no DB access', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);

    const result = await listCollectionArticles(deps(db), OWNER, 'c-1', {
      cursor: 'not-a-valid-cursor!!',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(db.calls).toHaveLength(0);
  });

  it('rejects listing another user collection with FORBIDDEN', async () => {
    const db = new FakeQueryable([
      { rows: [collectionRow({ user_id: OTHER })] },
    ]);

    const result = await listCollectionArticles(deps(db), OWNER, 'c-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.FORBIDDEN);
    }
  });
});

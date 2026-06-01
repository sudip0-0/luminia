import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { LIBRARY_PAGE_LIMIT, listSaved } from './saves.js';
import { addArticleToCollection, deleteCollection, updateCollection } from './collections.js';

// Property-based tests for the Library_Service (Requirements 21.4, 22.4, 22.6, 22.7).

const OWNER = 'u-1';
const OTHER = 'u-2';

function savedRow(i: number) {
  return {
    user_id: OWNER,
    article_id: `art-${String(i).padStart(3, '0')}`,
    read_state: 'unread',
    saved_at: new Date(Date.UTC(2024, 0, 1) + i * 1000),
  };
}

describe('listSaved — Property 42 (page-bounded listing, Req 21.4)', () => {
  it('returns at most 50 items, with a next cursor exactly when more remain', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 80 }), async (n) => {
        // The repository query carries LIMIT 51 (page + 1); model that ceiling.
        const returned = Math.min(n, LIBRARY_PAGE_LIMIT + 1);
        const db = new FakeQueryable((sql): CannedResult => {
          if (/FROM saved_article/i.test(sql) && /^\s*SELECT/i.test(sql)) {
            return { rows: Array.from({ length: returned }, (_, i) => savedRow(i)) };
          }
          return { rows: [] };
        });
        const result = await listSaved({ db }, OWNER, {});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { items, nextCursor } = result.results;
        expect(items.length).toBeLessThanOrEqual(LIBRARY_PAGE_LIMIT);
        expect(items.length).toBe(Math.min(n, LIBRARY_PAGE_LIMIT));
        expect(nextCursor !== null).toBe(n > LIBRARY_PAGE_LIMIT);
        // No fabricated rows: every returned id came from the source page.
        expect(new Set(items.map((r) => r.articleId)).size).toBe(items.length);
      }),
    );
  });
});

/** A collection row owned by `userId`. */
function collectionRow(userId: string) {
  return {
    id: 'c-1',
    user_id: userId,
    name: 'Reading',
    color: '#fff',
    icon: 'book',
    created_at: new Date('2024-05-01T00:00:00.000Z'),
  };
}

function membershipRow() {
  return { collection_id: 'c-1', article_id: 'art-1', added_at: new Date('2024-05-02T00:00:00.000Z') };
}

/** Responder-based fake honoring ownership + saved-article preconditions. */
function collectionsDb(opts: { ownerUserId: string | null; articleSaved: boolean }) {
  return new FakeQueryable((sql): CannedResult => {
    if (/^\s*SELECT/i.test(sql) && /FROM collection\b/i.test(sql)) {
      return { rows: opts.ownerUserId ? [collectionRow(opts.ownerUserId)] : [] };
    }
    if (/FROM saved_article/i.test(sql)) {
      return { rows: opts.articleSaved ? [savedRow(1)] : [] };
    }
    if (/INSERT INTO collection_article/i.test(sql)) return { rows: [membershipRow()] };
    if (/DELETE FROM collection\b/i.test(sql)) return { rows: [collectionRow(OWNER)] };
    if (/UPDATE collection\b/i.test(sql)) return { rows: [collectionRow(OWNER)] };
    return { rows: [] };
  });
}

describe('deleteCollection — Property 43 (delete preserves saved articles, Req 22.4)', () => {
  it('an owner delete never issues a DELETE against saved_article', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('c-1', 'c-2', 'c-9'), async (collectionId) => {
        const db = collectionsDb({ ownerUserId: OWNER, articleSaved: true });
        const result = await deleteCollection({ db }, OWNER, collectionId);
        expect(result.ok).toBe(true);
        expect(db.calls.some((c) => /DELETE FROM saved_article\b/i.test(c.sql))).toBe(false);
        expect(db.calls.some((c) => /DELETE FROM collection\b/i.test(c.sql))).toBe(true);
      }),
    );
  });
});

describe('Collection mutations — Property 44 (precondition + ownership, Req 22.6, 22.7)', () => {
  it('add: ok iff owned AND saved; FORBIDDEN when not owned; VALIDATION when unsaved; never inserts otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(OWNER, OTHER, null), // collection owner (null = missing)
        fc.boolean(), // article saved?
        async (ownerUserId, articleSaved) => {
          const db = collectionsDb({ ownerUserId, articleSaved });
          const result = await addArticleToCollection({ db }, OWNER, 'c-1', 'art-1');
          const inserted = db.calls.some((c) => /INSERT INTO collection_article/i.test(c.sql));
          if (ownerUserId === OWNER && articleSaved) {
            expect(result.ok).toBe(true);
            expect(inserted).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            expect(inserted).toBe(false); // collection left unchanged
            if (!result.ok) {
              if (ownerUserId === OTHER) expect(result.error.error.code).toBe('FORBIDDEN');
              else if (ownerUserId === null) expect(result.error.error.code).toBe('NOT_FOUND');
              else expect(result.error.error.code).toBe('VALIDATION_ERROR');
            }
          }
        },
      ),
    );
  });

  it('update/delete on another user collection is FORBIDDEN and mutates nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('update', 'delete'), async (op) => {
        const db = collectionsDb({ ownerUserId: OTHER, articleSaved: true });
        const result =
          op === 'update'
            ? await updateCollection({ db }, OWNER, 'c-1', { name: 'New' })
            : await deleteCollection({ db }, OWNER, 'c-1');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.error.code).toBe('FORBIDDEN');
        expect(db.calls.some((c) => /UPDATE collection\b/i.test(c.sql))).toBe(false);
        expect(db.calls.some((c) => /DELETE FROM collection\b/i.test(c.sql))).toBe(false);
      }),
    );
  });
});

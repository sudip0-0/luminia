import { describe, it, expect } from 'vitest';
import { FakeQueryable } from './fake-queryable.js';
import {
  addArticleToCollection,
  createCollection,
  deleteCollection,
  listCollectionArticles,
  updateCollection,
} from './collections.repository.js';

// Verifies the collections repository: CRUD with ownership scoping
// (Requirement 22.7), add-article membership (22.2), paginated contents (22.5).

function collectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    user_id: 'u-1',
    name: 'Reading',
    color: '#fff',
    icon: 'book',
    created_at: new Date('2024-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createCollection', () => {
  it('inserts with parameterized fields and maps the row', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);
    const created = await createCollection(db, {
      userId: 'u-1',
      name: 'Reading',
      color: '#fff',
      icon: 'book',
    });
    expect(db.lastCall.params).toEqual(['u-1', 'Reading', '#fff', 'book']);
    expect(created.id).toBe('c-1');
    expect(created.userId).toBe('u-1');
  });
});

describe('updateCollection', () => {
  it('scopes the update by owner and parameterizes id + user last', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow({ name: 'New' })] }]);
    const updated = await updateCollection(db, 'u-1', 'c-1', { name: 'New' });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('name = $1');
    expect(sql).toContain('WHERE id = $2 AND user_id = $3');
    expect(params).toEqual(['New', 'c-1', 'u-1']);
    expect(updated?.name).toBe('New');
  });

  it('returns null when no owned row matches (foreign collection)', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await updateCollection(db, 'other', 'c-1', { color: '#000' })).toBeNull();
  });

  it('with no fields, selects the owned row', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);
    await updateCollection(db, 'u-1', 'c-1', {});
    expect(db.lastCall.sql).toContain('SELECT');
    expect(db.lastCall.params).toEqual(['c-1', 'u-1']);
  });
});

describe('deleteCollection', () => {
  it('deletes scoped to the owner and returns the removed row', async () => {
    const db = new FakeQueryable([{ rows: [collectionRow()] }]);
    const removed = await deleteCollection(db, 'u-1', 'c-1');
    expect(db.lastCall.sql).toContain('DELETE FROM collection');
    expect(db.lastCall.sql).toContain('WHERE id = $1 AND user_id = $2');
    expect(db.lastCall.params).toEqual(['c-1', 'u-1']);
    expect(removed?.id).toBe('c-1');
  });

  it('returns null when the collection is not owned by the user', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await deleteCollection(db, 'other', 'c-1')).toBeNull();
  });
});

describe('addArticleToCollection', () => {
  it('inserts membership idempotently', async () => {
    const db = new FakeQueryable([
      { rows: [{ collection_id: 'c-1', article_id: 'art-1', added_at: new Date('2024-05-02T00:00:00.000Z') }] },
    ]);
    const membership = await addArticleToCollection(db, 'c-1', 'art-1');
    expect(db.lastCall.sql).toContain('ON CONFLICT (collection_id, article_id)');
    expect(db.lastCall.params).toEqual(['c-1', 'art-1']);
    expect(membership.collectionId).toBe('c-1');
    expect(membership.articleId).toBe('art-1');
  });
});

describe('listCollectionArticles', () => {
  it('joins article, orders by recency, and uses default limit', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listCollectionArticles(db, 'c-1');
    const { sql, params } = db.lastCall;
    expect(sql).toContain('JOIN article a ON a.id = ca.article_id');
    expect(sql).toContain('ca.collection_id = $1');
    expect(sql).toContain('ORDER BY ca.added_at DESC, ca.article_id DESC');
    expect(params).toEqual(['c-1', 50]);
  });

  it('applies the keyset cursor when provided', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listCollectionArticles(db, 'c-1', {
      cursorAddedAt: '2024-05-02T00:00:00.000Z',
      cursorArticleId: 'art-1',
      limit: 25,
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('(ca.added_at, ca.article_id) < ($2, $3)');
    expect(sql).toContain('LIMIT $4');
    expect(params).toEqual(['c-1', '2024-05-02T00:00:00.000Z', 'art-1', 25]);
  });
});

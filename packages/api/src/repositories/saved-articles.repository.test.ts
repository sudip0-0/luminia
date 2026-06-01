import { describe, it, expect } from 'vitest';
import { FakeQueryable } from './fake-queryable.js';
import {
  listSavedArticles,
  saveArticle,
  setReadState,
  unsaveArticle,
} from './saved-articles.repository.js';

// Verifies the saved-articles repository: idempotent save (Requirements 21.1,
// 21.5), unsave (21.2, 21.6), read-state (21.3), filtered keyset listing (21.4).

function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u-1',
    article_id: 'art-1',
    read_state: 'unread',
    saved_at: new Date('2024-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('saveArticle', () => {
  it('reports created=true when the insert returns a new row', async () => {
    const db = new FakeQueryable([{ rows: [savedRow()] }]);
    const { record, created } = await saveArticle(db, 'u-1', 'art-1');
    expect(db.lastCall.sql).toContain('ON CONFLICT (user_id, article_id) DO NOTHING');
    expect(db.lastCall.params).toEqual(['u-1', 'art-1']);
    expect(created).toBe(true);
    expect(record.readState).toBe('unread');
  });

  it('reports created=false and the existing row on a re-save (idempotent)', async () => {
    // First call (insert) returns no row (conflict); second call (select) returns existing.
    const db = new FakeQueryable([
      { rows: [] },
      { rows: [savedRow({ read_state: 'read' })] },
    ]);
    const { record, created } = await saveArticle(db, 'u-1', 'art-1');
    expect(created).toBe(false);
    expect(record.readState).toBe('read');
    expect(db.calls).toHaveLength(2);
  });
});

describe('unsaveArticle', () => {
  it('deletes by composite key and returns the removed row', async () => {
    const db = new FakeQueryable([{ rows: [savedRow()] }]);
    const removed = await unsaveArticle(db, 'u-1', 'art-1');
    expect(db.lastCall.sql).toContain('DELETE FROM saved_article');
    expect(db.lastCall.params).toEqual(['u-1', 'art-1']);
    expect(removed?.articleId).toBe('art-1');
  });

  it('returns null when the article was not saved', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await unsaveArticle(db, 'u-1', 'missing')).toBeNull();
  });
});

describe('setReadState', () => {
  it('updates the read_state with a parameterized value', async () => {
    const db = new FakeQueryable([{ rows: [savedRow({ read_state: 'read' })] }]);
    const updated = await setReadState(db, 'u-1', 'art-1', 'read');
    expect(db.lastCall.sql).toContain('SET read_state = $3');
    expect(db.lastCall.params).toEqual(['u-1', 'art-1', 'read']);
    expect(updated?.readState).toBe('read');
  });
});

describe('listSavedArticles', () => {
  it('lists with only the user filter and default page limit', async () => {
    const db = new FakeQueryable([{ rows: [savedRow()] }]);
    await listSavedArticles(db, 'u-1');
    const { sql, params } = db.lastCall;
    expect(sql).toContain('sa.user_id = $1');
    expect(sql).toContain('ORDER BY sa.saved_at DESC, sa.article_id DESC');
    expect(params).toEqual(['u-1', 50]);
  });

  it('joins article for a source filter and composes the keyset cursor', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listSavedArticles(db, 'u-1', {
      state: 'unread',
      source: 'hacker_news',
      cursorSavedAt: '2024-04-01T00:00:00.000Z',
      cursorArticleId: 'art-9',
      limit: 10,
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('JOIN article a ON a.id = sa.article_id');
    expect(sql).toContain('sa.read_state = $2');
    expect(sql).toContain('a.source = $3');
    expect(sql).toContain('(sa.saved_at, sa.article_id) < ($4, $5)');
    expect(sql).toContain('LIMIT $6');
    expect(params).toEqual([
      'u-1',
      'unread',
      'hacker_news',
      '2024-04-01T00:00:00.000Z',
      'art-9',
      10,
    ]);
  });
});

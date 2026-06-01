import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import {
  LIBRARY_PAGE_LIMIT,
  listSaved,
  saveArticle,
  setReadState,
  unsaveArticle,
  type LibrarySavesDeps,
} from './saves.js';

// Verifies the Library_Service save surface against an in-memory FakeQueryable:
// save idempotency (single row + single `save` event on re-save, Requirements
// 21.1/21.5), unsave records an `unsave` event and errors when not saved
// (21.2/21.6), read-state persistence (21.3), and the page-bounded, filterable
// listing (21.4).

const NOW_ISO = '2024-05-01T00:00:00.000Z';

/** A saved_article row as the DB returns it (snake_case). */
function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u-1',
    article_id: 'art-1',
    read_state: 'unread',
    saved_at: new Date('2024-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A feed_event row as the insert RETURNING clause produces it. */
function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fe-1',
    client_event_id: 'evt-1',
    user_id: 'u-1',
    article_id: 'art-1',
    topic_id: null,
    type: 'save',
    payload: {},
    occurred_at: new Date(NOW_ISO),
    created_at: new Date(NOW_ISO),
    ...overrides,
  };
}

/** Deterministic deps: fixed event id and clock for assertable events. */
function deps(db: FakeQueryable): LibrarySavesDeps {
  return { db, newEventId: () => 'evt-1', now: () => new Date(NOW_ISO) };
}

/** Find every recorded INSERT into feed_event. */
function feedEventInserts(db: FakeQueryable) {
  return db.calls.filter((c) => /INSERT INTO feed_event/i.test(c.sql));
}

describe('saveArticle', () => {
  it('saves with read state unread and records exactly one save event on first save', async () => {
    // 1st call: insert saved_article (returns the new row, created=true)
    // 2nd call: insert feed_event (the single `save` event)
    const db = new FakeQueryable([
      { rows: [savedRow()] },
      { rows: [eventRow()] },
    ]);

    const result = await saveArticle(deps(db), 'u-1', 'art-1');

    expect(result.created).toBe(true);
    expect(result.record.readState).toBe('unread');

    const events = feedEventInserts(db);
    expect(events).toHaveLength(1);
    // The recorded event is a `save` for this user/article with injected id/time.
    expect(events[0]?.params).toEqual([
      'u-1',
      'evt-1',
      'art-1',
      null,
      'save',
      JSON.stringify({}),
      NOW_ISO,
    ]);
  });

  it('is idempotent on re-save: no second row and no duplicate save event', async () => {
    // Re-save: insert returns no row (conflict), then the existing row is read
    // back. Because created=false, NO feed_event insert is issued.
    const db = new FakeQueryable([
      { rows: [] }, // INSERT ... ON CONFLICT DO NOTHING -> no row
      { rows: [savedRow({ read_state: 'read' })] }, // SELECT existing row
    ]);

    const result = await saveArticle(deps(db), 'u-1', 'art-1');

    expect(result.created).toBe(false);
    // Existing read state is left unchanged (Requirement 21.5).
    expect(result.record.readState).toBe('read');
    // Crucially, no `save` Feed_Event was recorded on the re-save.
    expect(feedEventInserts(db)).toHaveLength(0);
  });
});

describe('unsaveArticle', () => {
  it('removes the row and records an unsave event', async () => {
    const db = new FakeQueryable([
      { rows: [savedRow()] }, // DELETE ... RETURNING -> removed row
      { rows: [eventRow({ type: 'unsave' })] }, // feed_event insert
    ]);

    const result = await unsaveArticle(deps(db), 'u-1', 'art-1');

    expect(result.ok).toBe(true);
    const events = feedEventInserts(db);
    expect(events).toHaveLength(1);
    expect(events[0]?.params).toEqual([
      'u-1',
      'evt-1',
      'art-1',
      null,
      'unsave',
      JSON.stringify({}),
      NOW_ISO,
    ]);
  });

  it('errors with NOT_FOUND and records no unsave event when not saved', async () => {
    const db = new FakeQueryable([{ rows: [] }]); // DELETE removes nothing

    const result = await unsaveArticle(deps(db), 'u-1', 'missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.NOT_FOUND);
    }
    expect(feedEventInserts(db)).toHaveLength(0);
  });
});

describe('setReadState', () => {
  it('persists the read state of a saved article', async () => {
    const db = new FakeQueryable([{ rows: [savedRow({ read_state: 'read' })] }]);

    const result = await setReadState(deps(db), 'u-1', 'art-1', 'read');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.readState).toBe('read');
    }
    // The repository performs a parameterized UPDATE with the new state.
    expect(db.lastCall.sql).toContain('SET read_state = $3');
    expect(db.lastCall.params).toEqual(['u-1', 'art-1', 'read']);
  });

  it('errors with NOT_FOUND when the article is not saved', async () => {
    const db = new FakeQueryable([{ rows: [] }]);

    const result = await setReadState(deps(db), 'u-1', 'missing', 'read');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });
});

describe('listSaved', () => {
  it('caps a page at 50, fetching one extra row to detect a next page', async () => {
    // Return LIMIT+1 rows so a further page is detected.
    const rows = Array.from({ length: LIBRARY_PAGE_LIMIT + 1 }, (_, n) =>
      savedRow({
        article_id: `art-${n}`,
        saved_at: new Date(Date.UTC(2024, 3, 1, 0, 0, LIBRARY_PAGE_LIMIT - n)),
      }),
    );
    const db = new FakeQueryable([{ rows }]);

    const result = await listSaved(deps(db), 'u-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toHaveLength(LIBRARY_PAGE_LIMIT);
      expect(result.results.nextCursor).not.toBeNull();
    }
    // The repository was asked for LIMIT+1 rows (keyset over-fetch).
    expect(db.lastCall.params.at(-1)).toBe(LIBRARY_PAGE_LIMIT + 1);
  });

  it('returns no next cursor when fewer than a full page exist', async () => {
    const db = new FakeQueryable([{ rows: [savedRow(), savedRow({ article_id: 'art-2' })] }]);

    const result = await listSaved(deps(db), 'u-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toHaveLength(2);
      expect(result.results.nextCursor).toBeNull();
    }
  });

  it('applies the read-state and source filters', async () => {
    const db = new FakeQueryable([{ rows: [] }]);

    await listSaved(deps(db), 'u-1', { state: 'unread', source: 'hacker_news' });

    const sql = normalizeSql(db.lastCall.sql);
    expect(sql).toContain('JOIN article a ON a.id = sa.article_id');
    expect(sql).toContain('sa.read_state = $2');
    expect(sql).toContain('a.source = $3');
    expect(db.lastCall.params).toEqual([
      'u-1',
      'unread',
      'hacker_news',
      LIBRARY_PAGE_LIMIT + 1,
    ]);
  });

  it('round-trips its own next cursor into the keyset filter on the next page', async () => {
    // Page 1 returns a full page + 1 so a cursor is emitted.
    const rows = Array.from({ length: LIBRARY_PAGE_LIMIT + 1 }, (_, n) =>
      savedRow({
        article_id: `art-${n}`,
        saved_at: new Date(Date.UTC(2024, 3, 1, 0, 0, LIBRARY_PAGE_LIMIT - n)),
      }),
    );
    const db1 = new FakeQueryable([{ rows }]);
    const page1 = await listSaved(deps(db1), 'u-1');
    expect(page1.ok).toBe(true);
    const cursor = page1.ok ? page1.results.nextCursor : null;
    expect(cursor).not.toBeNull();

    // Page 2 with that cursor must feed the keyset into the repository params.
    const db2 = new FakeQueryable([{ rows: [] }]);
    await listSaved(deps(db2), 'u-1', { cursor: cursor ?? undefined });
    const sql = normalizeSql(db2.lastCall.sql);
    expect(sql).toContain('(sa.saved_at, sa.article_id) < ($2, $3)');
  });

  it('rejects a malformed cursor with a validation error', async () => {
    const db = new FakeQueryable([{ rows: [] }]);

    const result = await listSaved(deps(db), 'u-1', { cursor: 'not-a-valid-cursor!!' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    // No query should be issued for a malformed cursor.
    expect(db.calls).toHaveLength(0);
  });
});

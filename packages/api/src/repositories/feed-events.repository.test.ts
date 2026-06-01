import { describe, it, expect } from 'vitest';
import { FakeQueryable } from './fake-queryable.js';
import {
  findExistingClientEventIds,
  insertFeedEvents,
  listFeedEventsInWindow,
} from './feed-events.repository.js';

// Verifies the feed-events repository: idempotent batch insert on
// (user_id, client_event_id) (Requirements 13.1, 13.4) and windowed queries
// (Requirement 14.2).

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fe-1',
    client_event_id: 'ce-1',
    user_id: 'u-1',
    article_id: 'art-1',
    topic_id: null,
    type: 'impression',
    payload: { dwellMs: 1200 },
    occurred_at: new Date('2024-03-01T00:00:00.000Z'),
    created_at: new Date('2024-03-01T00:00:01.000Z'),
    ...overrides,
  };
}

describe('insertFeedEvents', () => {
  it('is a no-op for an empty batch (issues no query)', async () => {
    const db = new FakeQueryable();
    const result = await insertFeedEvents(db, 'u-1', []);
    expect(result).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('builds a multi-row insert with ON CONFLICT DO NOTHING and serialized payload', async () => {
    const db = new FakeQueryable([{ rows: [eventRow(), eventRow({ id: 'fe-2', client_event_id: 'ce-2', article_id: null, topic_id: 't-1', type: 'mute_topic' })] }]);
    const inserted = await insertFeedEvents(db, 'u-1', [
      {
        clientEventId: 'ce-1',
        articleId: 'art-1',
        type: 'impression',
        payload: { dwellMs: 1200 },
        occurredAt: '2024-03-01T00:00:00.000Z',
      },
      {
        clientEventId: 'ce-2',
        topicId: 't-1',
        type: 'mute_topic',
        occurredAt: '2024-03-01T00:01:00.000Z',
      },
    ]);

    const { sql, params } = db.lastCall;
    expect(sql).toContain('ON CONFLICT (user_id, client_event_id) DO NOTHING');
    expect(sql).toContain('$6::jsonb');
    // user id first, then 6 params per event
    expect(params[0]).toBe('u-1');
    expect(params[1]).toBe('ce-1');
    expect(params[2]).toBe('art-1');
    expect(params[3]).toBeNull(); // topic id
    expect(params[4]).toBe('impression');
    expect(params[5]).toBe(JSON.stringify({ dwellMs: 1200 }));
    expect(params[6]).toBe('2024-03-01T00:00:00.000Z');
    // second event defaults payload to {}
    expect(params[11]).toBe(JSON.stringify({}));
    expect(inserted).toHaveLength(2);
    expect(inserted[1]?.type).toBe('mute_topic');
    expect(inserted[0]?.payload).toEqual({ dwellMs: 1200 });
  });

  it('returns only the rows the DB reports inserted (duplicates skipped)', async () => {
    // Two submitted, but only one new row returned -> the other was a duplicate.
    const db = new FakeQueryable([{ rows: [eventRow()] }]);
    const inserted = await insertFeedEvents(db, 'u-1', [
      { clientEventId: 'ce-1', type: 'save', occurredAt: '2024-03-01T00:00:00.000Z' },
      { clientEventId: 'ce-1', type: 'save', occurredAt: '2024-03-01T00:00:00.000Z' },
    ]);
    expect(inserted).toHaveLength(1);
  });
});

describe('findExistingClientEventIds', () => {
  it('is a no-op for an empty input', async () => {
    const db = new FakeQueryable();
    expect(await findExistingClientEventIds(db, 'u-1', [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('parameterizes the user and the id IN-list starting at $2', async () => {
    const db = new FakeQueryable([
      { rows: [{ client_event_id: 'ce-1' }, { client_event_id: 'ce-3' }] },
    ]);
    const existing = await findExistingClientEventIds(db, 'u-1', ['ce-1', 'ce-2', 'ce-3']);
    const { sql, params } = db.lastCall;
    expect(sql).toContain('client_event_id IN ($2, $3, $4)');
    expect(params).toEqual(['u-1', 'ce-1', 'ce-2', 'ce-3']);
    expect(existing).toEqual(['ce-1', 'ce-3']);
  });
});

describe('listFeedEventsInWindow', () => {
  it('uses an inclusive-lower, exclusive-upper window and maps rows', async () => {
    const db = new FakeQueryable([{ rows: [eventRow()] }]);
    const events = await listFeedEventsInWindow(db, 'u-1', {
      from: '2024-02-01T00:00:00.000Z',
      to: '2024-03-03T00:00:00.000Z',
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('occurred_at >= $2');
    expect(sql).toContain('occurred_at < $3');
    expect(sql).not.toContain('type IN');
    expect(params).toEqual([
      'u-1',
      '2024-02-01T00:00:00.000Z',
      '2024-03-03T00:00:00.000Z',
    ]);
    expect(events[0]?.payload).toEqual({ dwellMs: 1200 });
  });

  it('appends a parameterized type filter when types are provided', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listFeedEventsInWindow(db, 'u-1', {
      from: '2024-02-01T00:00:00.000Z',
      to: '2024-03-03T00:00:00.000Z',
      types: ['save', 'skip'],
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('type IN ($4, $5)');
    expect(params).toEqual([
      'u-1',
      '2024-02-01T00:00:00.000Z',
      '2024-03-03T00:00:00.000Z',
      'save',
      'skip',
    ]);
  });
});

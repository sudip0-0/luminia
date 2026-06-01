import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { QueryRow } from '../repositories/queryable.js';
import {
  createTopicMuteDataAccess,
  muteTopic,
  unmuteTopic,
  type TopicMuteDataAccess,
} from './mute.js';

// Verifies the Feed_Service topic mute/unmute persistence service
// (Requirements 25.3-25.6) over a FakeQueryable, so the `setUserTopicMuted`
// UPDATE is exercised without a live database:
//   - mute persists muted = true and is idempotent on re-mute (25.3, 25.4, 25.5)
//   - unmute persists muted = false and is idempotent (25.4, 25.5)
//   - NOT_FOUND (uniform envelope) when the user_topic association is absent (25.6)
//   - round-trip: mute then unmute flips the persisted flag both ways

const USER = 'u-1';
const TOPIC = 't-physics';

/** A raw `user_topic` row as returned by `pg`, with overridable columns. */
function userTopicRow(overrides: Record<string, unknown> = {}): QueryRow {
  return {
    user_id: USER,
    topic_id: TOPIC,
    weight: '1',
    source: 'onboarding',
    muted: false,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Build a {@link FakeQueryable} backed by a tiny in-memory `user_topic` store
 * keyed by `(user_id, topic_id)`. The UPDATE ... muted = $3 statement mutates
 * the stored row and returns it (mirroring `RETURNING`), or returns no rows
 * when the association is absent — so idempotency and the not-found path are
 * exercised against real state transitions rather than canned per-call rows.
 */
function makeDb(seed: QueryRow[] = []): FakeQueryable {
  const store = new Map<string, QueryRow>();
  for (const row of seed) {
    store.set(`${row.user_id as string}::${row.topic_id as string}`, { ...row });
  }
  return new FakeQueryable((sql, params) => {
    const n = normalizeSql(sql);
    if (n.includes('UPDATE user_topic SET muted =')) {
      const [userId, topicId, muted] = params as [string, string, boolean];
      const key = `${userId}::${topicId}`;
      const existing = store.get(key);
      if (!existing) return { rows: [] };
      existing.muted = muted;
      return { rows: [{ ...existing }] };
    }
    return { rows: [] };
  });
}

describe('muteTopic', () => {
  it('persists muted = true for an associated topic (25.3, 25.5)', async () => {
    const db = makeDb([userTopicRow({ muted: false })]);

    const result = await muteTopic(createTopicMuteDataAccess(db), USER, TOPIC);

    expect(result).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: true } });
    // The UPDATE was issued with [userId, topicId, true].
    const call = db.calls.find((c) => c.sql.includes('UPDATE user_topic SET muted ='));
    expect(call?.params).toEqual([USER, TOPIC, true]);
  });

  it('is idempotent: re-muting an already-muted topic preserves muted = true and returns success (25.4)', async () => {
    const db = makeDb([userTopicRow({ muted: true })]);

    const first = await muteTopic(createTopicMuteDataAccess(db), USER, TOPIC);
    const second = await muteTopic(createTopicMuteDataAccess(db), USER, TOPIC);

    expect(first).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: true } });
    expect(second).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: true } });
  });

  it('returns NOT_FOUND (uniform envelope) when the topic is not associated with the user (25.6)', async () => {
    const db = makeDb([]); // no association

    const result = await muteTopic(createTopicMuteDataAccess(db), USER, 't-missing');

    expect(result).toEqual({
      status: 'not-found',
      error: {
        error: {
          code: 'NOT_FOUND',
          message: 'Topic not found for user',
          details: { topicId: 't-missing' },
        },
      },
    });
  });
});

describe('unmuteTopic', () => {
  it('persists muted = false for an associated, muted topic (25.4, 25.5)', async () => {
    const db = makeDb([userTopicRow({ muted: true })]);

    const result = await unmuteTopic(createTopicMuteDataAccess(db), USER, TOPIC);

    expect(result).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: false } });
    const call = db.calls.find((c) => c.sql.includes('UPDATE user_topic SET muted ='));
    expect(call?.params).toEqual([USER, TOPIC, false]);
  });

  it('is idempotent: unmuting a topic that is not muted preserves muted = false and returns success (25.5)', async () => {
    const db = makeDb([userTopicRow({ muted: false })]);

    const first = await unmuteTopic(createTopicMuteDataAccess(db), USER, TOPIC);
    const second = await unmuteTopic(createTopicMuteDataAccess(db), USER, TOPIC);

    expect(first).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: false } });
    expect(second).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: false } });
  });

  it('returns NOT_FOUND when the topic is not associated with the user (25.6)', async () => {
    const db = makeDb([]);

    const result = await unmuteTopic(createTopicMuteDataAccess(db), USER, 't-missing');

    expect(result).toEqual({
      status: 'not-found',
      error: {
        error: {
          code: 'NOT_FOUND',
          message: 'Topic not found for user',
          details: { topicId: 't-missing' },
        },
      },
    });
  });
});

describe('mute/unmute round-trip', () => {
  it('mute then unmute flips the persisted muted flag both ways (25.3, 25.4)', async () => {
    const db = makeDb([userTopicRow({ muted: false })]);
    const deps = createTopicMuteDataAccess(db);

    const muted = await muteTopic(deps, USER, TOPIC);
    expect(muted).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: true } });

    const unmuted = await unmuteTopic(deps, USER, TOPIC);
    expect(unmuted).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: false } });

    // And back to muted, confirming the state is genuinely round-tripping.
    const remuted = await muteTopic(deps, USER, TOPIC);
    expect(remuted).toEqual({ status: 'ok', topic: { topicId: TOPIC, muted: true } });
  });
});

describe('createTopicMuteDataAccess wiring', () => {
  it('satisfies the TopicMuteDataAccess interface', () => {
    const access: TopicMuteDataAccess = createTopicMuteDataAccess(makeDb());
    expect(typeof access.setMuted).toBe('function');
  });
});

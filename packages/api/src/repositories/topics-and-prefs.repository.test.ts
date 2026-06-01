import { describe, it, expect } from 'vitest';
import { FakeQueryable } from './fake-queryable.js';
import { findTopicsByIds, listTopics } from './topics.repository.js';
import {
  listActiveUserTopics,
  setUserTopicMuted,
  upsertUserTopic,
} from './user-topics.repository.js';
import {
  listEnabledSources,
  setUserSourceEnabled,
} from './user-sources.repository.js';

// Verifies the taxonomy + preference repositories: topic reads (Requirement
// 3.1, 3.3), user-topic upsert/mute (3.5, 25.x), and source toggles (3.7).

describe('topics repository', () => {
  it('lists topics ordered by slug and maps centroid vectors', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            id: 't-1',
            slug: 'physics',
            label: 'Physics',
            parent_id: null,
            color: '#1',
            icon_name: 'atom',
            centroid: '[0.1,0.2]',
          },
        ],
      },
    ]);
    const topics = await listTopics(db);
    expect(db.lastCall.sql).toContain('ORDER BY slug ASC');
    expect(topics[0]?.centroid).toEqual([0.1, 0.2]);
    expect(topics[0]?.parentId).toBeNull();
  });

  it('findTopicsByIds builds an IN-list and is a no-op when empty', async () => {
    const empty = new FakeQueryable();
    expect(await findTopicsByIds(empty, [])).toEqual([]);
    expect(empty.calls).toHaveLength(0);

    const db = new FakeQueryable([{ rows: [] }]);
    await findTopicsByIds(db, ['a', 'b', 'c']);
    expect(db.lastCall.sql).toContain('id IN ($1, $2, $3)');
    expect(db.lastCall.params).toEqual(['a', 'b', 'c']);
  });
});

describe('user-topics repository', () => {
  it('upserts with source/weight/muted and ON CONFLICT update', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            user_id: 'u-1',
            topic_id: 't-1',
            weight: '1',
            source: 'onboarding',
            muted: false,
            created_at: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      },
    ]);
    const ut = await upsertUserTopic(db, 'u-1', {
      topicId: 't-1',
      weight: 1.0,
      source: 'onboarding',
    });
    expect(db.lastCall.sql).toContain('ON CONFLICT (user_id, topic_id) DO UPDATE');
    expect(db.lastCall.params).toEqual(['u-1', 't-1', 1, 'onboarding', false]);
    expect(ut.weight).toBe(1);
    expect(ut.source).toBe('onboarding');
  });

  it('listActiveUserTopics filters weight>0 and not muted, ordered desc', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listActiveUserTopics(db, 'u-1', 10);
    const { sql, params } = db.lastCall;
    expect(sql).toContain('weight > 0 AND muted = false');
    expect(sql).toContain('ORDER BY weight DESC');
    expect(params).toEqual(['u-1', 10]);
  });

  it('setUserTopicMuted returns null when not associated (not-found path)', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await setUserTopicMuted(db, 'u-1', 't-x', true)).toBeNull();
    expect(db.lastCall.params).toEqual(['u-1', 't-x', true]);
  });
});

describe('user-sources repository', () => {
  it('upserts the enabled state per source', async () => {
    const db = new FakeQueryable([
      { rows: [{ user_id: 'u-1', source: 'medium', enabled: false }] },
    ]);
    const rec = await setUserSourceEnabled(db, 'u-1', 'medium', false);
    expect(db.lastCall.sql).toContain('ON CONFLICT (user_id, source) DO UPDATE');
    expect(db.lastCall.params).toEqual(['u-1', 'medium', false]);
    expect(rec.enabled).toBe(false);
  });

  it('listEnabledSources returns only enabled source names', async () => {
    const db = new FakeQueryable([
      { rows: [{ source: 'wikipedia' }, { source: 'arxiv' }] },
    ]);
    const sources = await listEnabledSources(db, 'u-1');
    expect(db.lastCall.sql).toContain('enabled = true');
    expect(sources).toEqual(['wikipedia', 'arxiv']);
  });
});

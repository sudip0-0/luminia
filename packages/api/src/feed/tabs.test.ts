import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { CannedResult } from '../repositories/fake-queryable.js';
import { FORYOU_TAB } from './candidates.js';
import { FORYOU_TAB_LABEL, MAX_TOPIC_TABS, getTabs } from './tabs.js';

// Verifies the active feed tabs (design `getTabs`, Requirement 8.5): the
// response begins with `foryou`, FIRST, followed by 1-10 topic tabs ordered by
// descending current topic weight, including only topics whose weight is
// strictly greater than 0, capped at 10. DB access goes through a
// responder-based FakeQueryable that branches on the SQL it receives, so the
// filtering/ordering/capping is exercised over canned rows without a live
// database.

/** A `user_topic` row in the snake_case shape `mapUserTopic` expects. */
function userTopicRow(
  topicId: string,
  weight: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    user_id: 'u1',
    topic_id: topicId,
    weight: String(weight),
    source: 'onboarding',
    muted: false,
    created_at: new Date('2024-01-15T12:00:00.000Z'),
    ...overrides,
  };
}

/** A `topic` row in the shape `mapTopic` expects. */
function topicRow(id: string, slug: string, label = slug) {
  return {
    id,
    slug,
    label,
    parent_id: null,
    color: '#fff',
    icon_name: 'icon',
    centroid: null,
  };
}

/** Options describing the canned rows each query should return. */
interface FakeData {
  userTopics?: ReturnType<typeof userTopicRow>[];
  topics?: ReturnType<typeof topicRow>[];
}

/**
 * Build a responder-based FakeQueryable returning canned rows keyed by which
 * statement is executing: the user-topic read (`FROM user_topic`) and the
 * topic-resolution read (`FROM topic`).
 */
function fakeDb(data: FakeData): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM user_topic')) {
      return { rows: data.userTopics ?? [] };
    }
    if (s.includes('FROM topic')) {
      return { rows: data.topics ?? [] };
    }
    return { rows: [] };
  });
}

describe('getTabs — foryou is always first (Req 8.5)', () => {
  it('returns foryou as the first tab even with no topic tabs', async () => {
    const db = fakeDb({ userTopics: [], topics: [] });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs[0]).toEqual({ key: FORYOU_TAB, label: FORYOU_TAB_LABEL });
    expect(res.tabs).toHaveLength(1);
  });

  it('places foryou before every topic tab', async () => {
    const db = fakeDb({
      userTopics: [userTopicRow('t-a', 1.5), userTopicRow('t-b', 0.5)],
      topics: [topicRow('t-a', 'alpha'), topicRow('t-b', 'beta')],
    });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs[0].key).toBe(FORYOU_TAB);
    expect(res.tabs.slice(1).map((t) => t.key)).toEqual(['alpha', 'beta']);
  });
});

describe('getTabs — descending weight ordering (Req 8.5)', () => {
  it('orders topic tabs by descending weight regardless of input order', async () => {
    const db = fakeDb({
      // Intentionally supplied out of weight order.
      userTopics: [
        userTopicRow('t-low', 0.2),
        userTopicRow('t-high', 1.9),
        userTopicRow('t-mid', 1.0),
      ],
      topics: [
        topicRow('t-low', 'low'),
        topicRow('t-high', 'high'),
        topicRow('t-mid', 'mid'),
      ],
    });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs.map((t) => t.key)).toEqual([FORYOU_TAB, 'high', 'mid', 'low']);
  });

  it('breaks equal-weight ties deterministically by ascending topic id', async () => {
    const db = fakeDb({
      userTopics: [
        userTopicRow('t-zeta', 1.0),
        userTopicRow('t-alpha', 1.0),
      ],
      topics: [topicRow('t-zeta', 'zeta'), topicRow('t-alpha', 'alpha')],
    });

    const res = await getTabs({ db }, 'u1');

    // Equal weights -> ascending topic id (t-alpha before t-zeta).
    expect(res.tabs.slice(1).map((t) => t.key)).toEqual(['alpha', 'zeta']);
  });
});

describe('getTabs — weight-0 topics excluded (Req 8.5)', () => {
  it('excludes topics whose weight is exactly 0', async () => {
    const db = fakeDb({
      userTopics: [
        userTopicRow('t-keep', 0.8),
        userTopicRow('t-zero', 0),
      ],
      topics: [topicRow('t-keep', 'keep'), topicRow('t-zero', 'zero')],
    });

    const res = await getTabs({ db }, 'u1');

    const topicKeys = res.tabs.slice(1).map((t) => t.key);
    expect(topicKeys).toEqual(['keep']);
    expect(topicKeys).not.toContain('zero');
  });

  it('returns only foryou when every topic has weight 0', async () => {
    const db = fakeDb({
      userTopics: [userTopicRow('t-a', 0), userTopicRow('t-b', 0)],
      topics: [topicRow('t-a', 'alpha'), topicRow('t-b', 'beta')],
    });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs).toEqual([{ key: FORYOU_TAB, label: FORYOU_TAB_LABEL }]);
  });
});

describe('getTabs — topic tabs capped at 10 and 1-10 bound (Req 8.5)', () => {
  it('caps the topic tabs at 10, keeping the highest-weight topics', async () => {
    // 15 positive-weight topics with strictly descending weights.
    const userTopics = Array.from({ length: 15 }, (_, i) =>
      userTopicRow(`t-${String(i).padStart(2, '0')}`, 15 - i),
    );
    const topics = Array.from({ length: 15 }, (_, i) =>
      topicRow(`t-${String(i).padStart(2, '0')}`, `slug-${String(i).padStart(2, '0')}`),
    );
    const db = fakeDb({ userTopics, topics });

    const res = await getTabs({ db }, 'u1');

    const topicTabs = res.tabs.slice(1);
    expect(topicTabs).toHaveLength(MAX_TOPIC_TABS);
    // The 10 highest weights are t-00..t-09 (weights 15..6).
    expect(topicTabs.map((t) => t.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `slug-${String(i).padStart(2, '0')}`),
    );
    // Total tabs = foryou + 10 topic tabs.
    expect(res.tabs).toHaveLength(MAX_TOPIC_TABS + 1);
  });

  it('returns between 1 and 10 topic tabs for any positive-weight set', async () => {
    for (const n of [1, 5, 10, 11, 25]) {
      const userTopics = Array.from({ length: n }, (_, i) =>
        userTopicRow(`t-${String(i).padStart(3, '0')}`, n - i),
      );
      const topics = Array.from({ length: n }, (_, i) =>
        topicRow(`t-${String(i).padStart(3, '0')}`, `slug-${String(i).padStart(3, '0')}`),
      );
      const db = fakeDb({ userTopics, topics });

      const res = await getTabs({ db }, 'u1');

      const topicTabCount = res.tabs.length - 1; // exclude the foryou tab
      expect(topicTabCount).toBeGreaterThanOrEqual(1);
      expect(topicTabCount).toBeLessThanOrEqual(MAX_TOPIC_TABS);
      expect(res.tabs[0].key).toBe(FORYOU_TAB);
    }
  });
});

describe('getTabs — slug/label resolution', () => {
  it('carries each topic tab its slug as key and its label', async () => {
    const db = fakeDb({
      userTopics: [userTopicRow('t-physics', 1.2)],
      topics: [topicRow('t-physics', 'physics', 'Physics')],
    });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs[1]).toEqual({ key: 'physics', label: 'Physics' });
  });

  it('defensively skips a positive-weight topic whose row cannot be resolved', async () => {
    const db = fakeDb({
      userTopics: [userTopicRow('t-known', 1.0), userTopicRow('t-missing', 0.9)],
      // Only the known topic resolves; t-missing has no topic row.
      topics: [topicRow('t-known', 'known')],
    });

    const res = await getTabs({ db }, 'u1');

    expect(res.tabs.map((t) => t.key)).toEqual([FORYOU_TAB, 'known']);
  });
});

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { FakeQueryable, normalizeSql, type CannedResult } from '../repositories/fake-queryable.js';
import { FORYOU_TAB } from './candidates.js';
import { MAX_TOPIC_TABS, getTabs } from './tabs.js';

// Feature: lumina, Property 13: Active tabs are filtered and ordered
// Validates: Requirements 8.5

function userTopicRow(topicId: string, weight: number) {
  return {
    user_id: 'u1',
    topic_id: topicId,
    weight: String(weight),
    source: 'onboarding',
    muted: false,
    created_at: new Date('2024-01-15T12:00:00.000Z'),
  };
}

function topicRow(id: string) {
  return { id, slug: `slug-${id}`, label: id, parent_id: null, color: '#fff', icon_name: 'i', centroid: null };
}

function fakeDb(userTopics: ReturnType<typeof userTopicRow>[]): FakeQueryable {
  const topics = userTopics.map((t) => topicRow(t.topic_id));
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM user_topic')) return { rows: userTopics };
    if (s.includes('FROM topic')) return { rows: topics };
    return { rows: [] };
  });
}

describe('getTabs — Property 13 (active tabs filtered and ordered)', () => {
  it('begins with foryou, excludes weight-0 topics, orders by descending weight, caps at 10', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.integer({ min: 0, max: 9999 }).map((n) => `t${n}`),
            weight: fc.float({ min: 0, max: 2, noNaN: true }),
          }),
          { minLength: 0, maxLength: 25, selector: (t) => t.id },
        ),
        async (topics) => {
          const db = fakeDb(topics.map((t) => userTopicRow(t.id, t.weight)));
          const res = await getTabs({ db }, 'u1');

          // (1) foryou is always first.
          expect(res.tabs[0].key).toBe(FORYOU_TAB);

          const topicTabs = res.tabs.slice(1);
          const positive = topics.filter((t) => t.weight > 0);

          // (2) weight-0 topics excluded; count is min(#positive, 10).
          expect(topicTabs.length).toBe(Math.min(positive.length, MAX_TOPIC_TABS));

          // (3) the selected topics are the highest-weight ones, ordered
          //     descending by weight (ties broken by ascending topic id).
          const expected = [...positive]
            .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.id < b.id ? -1 : 1))
            .slice(0, MAX_TOPIC_TABS)
            .map((t) => `slug-${t.id}`);
          expect(topicTabs.map((t) => t.key)).toEqual(expected);
        },
      ),
    );
  });
});

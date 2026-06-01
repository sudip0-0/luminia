import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { getTopicBreakdown } from './topics.js';

// Feature: lumina, Property 48: Topic breakdown is trend-classified and weight-ordered
// Validates: Requirements 24.2

const NOW = Date.parse('2025-06-01T00:00:00.000Z');
const TRENDS = ['growing', 'fading', 'steady'];

function userTopicRow(topicId: string, weight: number) {
  return {
    user_id: 'u-1',
    topic_id: topicId,
    weight,
    source: 'onboarding',
    muted: false,
    created_at: '2025-01-01T00:00:00.000Z',
  };
}

describe('getTopicBreakdown — Property 48', () => {
  it('returns one entry per topic, weight-ordered (descending), with a valid trend label', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.integer({ min: 0, max: 9999 }).map((n) => `t${n}`),
            weight: fc.double({ min: 0, max: 2, noNaN: true }),
          }),
          { selector: (t) => t.id, maxLength: 12 },
        ),
        async (topics) => {
          // listUserTopics orders by descending weight, then topic id — feed the
          // fake rows already in that order (the SQL contract getTopicBreakdown relies on).
          const ordered = [...topics].sort((a, b) =>
            b.weight !== a.weight ? b.weight - a.weight : a.id < b.id ? -1 : 1,
          );
          const db = new FakeQueryable((sql): CannedResult => {
            if (/from user_topic/i.test(sql)) {
              return { rows: ordered.map((t) => userTopicRow(t.id, t.weight)) };
            }
            return { rows: [] }; // no feed events, no associations
          });

          const breakdown = await getTopicBreakdown({ db }, 'u-1', NOW);

          // One entry per topic.
          expect(breakdown.map((b) => b.topicId)).toEqual(ordered.map((t) => t.id));
          // Weights are non-increasing (weight-ordered).
          for (let i = 1; i < breakdown.length; i += 1) {
            expect(breakdown[i - 1]!.weight).toBeGreaterThanOrEqual(breakdown[i]!.weight);
          }
          // Every trend is one of the three valid labels; no events => steady.
          for (const entry of breakdown) {
            expect(TRENDS).toContain(entry.trend);
            expect(entry.trend).toBe('steady');
          }
        },
      ),
    );
  });
});

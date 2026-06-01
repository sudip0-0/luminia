import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeMonthlyInsights, type ComputeMonthlyInsightsInput } from './monthly.js';
import type { FeedEventRecord } from '../repositories/types.js';

// Feature: lumina, Property 47: Insights monthly aggregates are computed from in-month events
// Validates: Requirements 24.1, 24.3

const MS_PER_MINUTE = 60_000;

function event(type: string, articleId: string | null, dwellMs: number, i: number): FeedEventRecord {
  return {
    id: `e-${i}`,
    clientEventId: `c-${i}`,
    userId: 'u-1',
    articleId,
    topicId: null,
    type: type as FeedEventRecord['type'],
    payload: { dwellMs },
    occurredAt: '2024-04-10T12:00:00.000Z',
    createdAt: '2024-04-10T12:00:00.000Z',
  };
}

describe('computeMonthlyInsights — Property 47', () => {
  it('counts distinct dwell articles and excludes skip events from quality minutes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom('dwell', 'skip', 'impression', 'expand'),
            articleId: fc.constantFrom('a1', 'a2', 'a3'),
            dwellMs: fc.integer({ min: 0, max: 300_000 }),
          }),
          { maxLength: 40 },
        ),
        (specs) => {
          const events = specs.map((s, i) => event(s.type, s.articleId, s.dwellMs, i));
          const input: ComputeMonthlyInsightsInput = {
            monthLabel: '2024-04',
            monthEvents: events,
            priorDwellEvents: [],
            sourceByArticleId: new Map(),
            topicsByArticleId: new Map(),
          };
          const result = computeMonthlyInsights(input);

          // (24.1) articles read = distinct article ids among dwell events.
          const expectedArticles = new Set(
            specs.filter((s) => s.type === 'dwell').map((s) => s.articleId),
          );
          expect(result.articlesRead).toBe(expectedArticles.size);

          // (24.3) quality minutes = floor(sum of dwellMs over NON-skip events / 60000).
          const expectedMs = specs
            .filter((s) => s.type !== 'skip')
            .reduce((sum, s) => sum + s.dwellMs, 0);
          expect(result.qualityReadingMinutes).toBe(Math.floor(expectedMs / MS_PER_MINUTE));

          // No source map => empty per-source breakdown; counts never negative.
          expect(result.readingTimeBySource).toEqual([]);
          expect(result.qualityReadingMinutes).toBeGreaterThanOrEqual(0);
          expect(result.month).toBe('2024-04');
        },
      ),
    );
  });

  it('returns all-zero aggregates for an empty month (Req 24.8)', () => {
    const result = computeMonthlyInsights({
      monthLabel: '2024-04',
      monthEvents: [],
      priorDwellEvents: [],
      sourceByArticleId: new Map(),
      topicsByArticleId: new Map(),
    });
    expect(result).toEqual({
      month: '2024-04',
      articlesRead: 0,
      qualityReadingMinutes: 0,
      newlyDiscoveredTopics: 0,
      readingTimeBySource: [],
    });
  });
});

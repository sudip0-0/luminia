import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { addSearchQuery, MAX_SEARCH_HISTORY } from './searchHistory.js';

// Feature: lumina, Property 40: Search history is bounded, unique, and
// recency-ordered. Validates Requirement 20.8.

describe('Property 40 — search history is bounded, unique, recency-ordered (Req 20.8)', () => {
  it('after a sequence of additions, history is <=50, unique, and newest-first', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 200 }), (queries) => {
        let history: string[] = [];
        for (const q of queries) history = addSearchQuery(history, q);

        // Bounded.
        expect(history.length).toBeLessThanOrEqual(MAX_SEARCH_HISTORY);
        // Unique.
        expect(new Set(history).size).toBe(history.length);
        // No empty entries were stored.
        expect(history.every((h) => h.trim().length > 0)).toBe(true);

        // Recency-ordered: the most recently added non-empty query is first.
        const lastNonEmpty = [...queries].reverse().map((q) => q.trim()).find((q) => q.length > 0);
        if (lastNonEmpty !== undefined) {
          expect(history[0]).toBe(lastNonEmpty);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('re-searching an existing query moves it to the front without duplicating', () => {
    const history = addSearchQuery(addSearchQuery(addSearchQuery([], 'a'), 'b'), 'a');
    expect(history).toEqual(['a', 'b']);
  });

  it('ignores empty / whitespace-only queries', () => {
    expect(addSearchQuery(['a'], '   ')).toEqual(['a']);
    expect(addSearchQuery(['a'], '')).toEqual(['a']);
  });
});

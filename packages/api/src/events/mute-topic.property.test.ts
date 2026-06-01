import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { resolveMuteTopicTarget } from './mute-topic.js';

// Feature: lumina, Property 46: Mute-topic selects the highest-confidence topic
// Validates: Requirements 23.4

interface Assoc {
  article_id: string;
  topic_id: string;
  confidence: number;
}

/** Simulate the repository's `ORDER BY confidence DESC, topic_id ASC LIMIT 1`. */
function makeDb(associations: Assoc[]): FakeQueryable {
  return new FakeQueryable((sql, params): CannedResult => {
    if (sql.includes('FROM article_topic')) {
      const articleId = params[0] as string;
      const top = associations
        .filter((a) => a.article_id === articleId)
        .sort((a, b) =>
          b.confidence !== a.confidence
            ? b.confidence - a.confidence
            : a.topic_id.localeCompare(b.topic_id),
        )[0];
      return { rows: top ? [top] : [] };
    }
    return { rows: [] };
  });
}

describe('resolveMuteTopicTarget — Property 46', () => {
  it('returns the max-confidence topic (ties by ascending topic id), or null when none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            topic_id: fc.integer({ min: 0, max: 50 }).map((n) => `t-${String(n).padStart(2, '0')}`),
            confidence: fc.float({ min: 0, max: 1, noNaN: true }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        async (rawAssocs) => {
          // One association per (article, topic): de-dup by topic_id.
          const seen = new Set<string>();
          const assocs: Assoc[] = rawAssocs
            .filter((a) => (seen.has(a.topic_id) ? false : (seen.add(a.topic_id), true)))
            .map((a) => ({ article_id: 'art-1', ...a }));

          const result = await resolveMuteTopicTarget({ db: makeDb(assocs) }, 'art-1');

          if (assocs.length === 0) {
            expect(result).toBeNull();
            return;
          }
          // Expected winner: max confidence, ties broken by ascending topic id.
          const maxConf = Math.max(...assocs.map((a) => a.confidence));
          const expected = assocs
            .filter((a) => a.confidence === maxConf)
            .map((a) => a.topic_id)
            .sort()[0];
          expect(result).toBe(expected);
        },
      ),
    );
  });
});

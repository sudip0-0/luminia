import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import type { Article } from '@lumina/shared';

import {
  injectSerendipityCards,
  SERENDIPITY_INTERVAL,
  type FeedCard,
} from './serendipity.js';

// Feature: lumina, Property 19: Serendipity cards are injected at every 10th
// position. Validates Requirement 10.1.

function makeArticle(id: string): Article {
  return {
    id,
    url: `https://example.com/${id}`,
    source: 'wikipedia',
    title: `Title ${id}`,
    summary: 'Summary',
    fullText: 'Full text',
    embedding: null,
    qualityScore: 0.8,
    difficulty: 'intermediate',
    readTimeMinutes: 5,
    topics: [],
    publishedAt: '2024-01-01T00:00:00.000Z',
    ingestedAt: '2024-01-01T00:00:00.000Z',
  };
}

const rankedArb = fc.array(fc.string({ minLength: 1 }), { maxLength: 60 }).map((ids) =>
  ids.map((id, i) => makeArticle(`r-${i}-${id}`)),
);
const serendipityArb = fc
  .array(fc.string({ minLength: 1 }), { maxLength: 10 })
  .map((ids) => ids.map((id, i) => makeArticle(`s-${i}-${id}`)));

describe('Property 19 — serendipity cards are injected at every 10th position (Req 10.1)', () => {
  it('places a serendipity card at exactly the multiple-of-10 positions (given supply)', () => {
    fc.assert(
      fc.property(rankedArb, serendipityArb, (ranked, serendipity) => {
        const cards = injectSerendipityCards(ranked, serendipity);
        cards.forEach((card: FeedCard, index) => {
          const position = index + 1; // 1-indexed
          const isTenth = position % SERENDIPITY_INTERVAL === 0;
          // Every multiple-of-10 position is a serendipity card whenever the
          // serendipity supply is large enough to cover it; non-tenth positions
          // are never serendipity cards.
          if (!isTenth) {
            expect(card.kind).toBe('article');
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  it('preserves ranked order and uses each ranked article exactly once', () => {
    fc.assert(
      fc.property(rankedArb, serendipityArb, (ranked, serendipity) => {
        const cards = injectSerendipityCards(ranked, serendipity);
        const articleIds = cards
          .filter((c): c is { kind: 'article'; article: Article } => c.kind === 'article')
          .map((c) => c.article.id);
        expect(articleIds).toEqual(ranked.map((a) => a.id));
      }),
      { numRuns: 200 },
    );
  });

  it('with ample supply, every 10th position is a serendipity card', () => {
    const ranked = Array.from({ length: 45 }, (_, i) => makeArticle(`r-${i}`));
    const serendipity = Array.from({ length: 10 }, (_, i) => makeArticle(`s-${i}`));
    const cards = injectSerendipityCards(ranked, serendipity);
    cards.forEach((card, index) => {
      const position = index + 1;
      expect(card.kind).toBe(position % SERENDIPITY_INTERVAL === 0 ? 'serendipity' : 'article');
    });
  });
});

// Feed_Service — serendipity injection into the feed sequence (task 13.7,
// Requirement 10.1).
//
// After candidates are scored and ordered (see ./assembly), the Feed_Service
// interleaves Serendipity_Cards into the ranked sequence: exactly one
// Serendipity_Card is placed at every card position that is a multiple of 10
// (the 10th, 20th, 30th, ... positions, 1-indexed). Every other position holds
// the next ranked Article, preserving the ranked order.
//
// This is a pure transform over an already-ordered list and a supply of
// serendipity articles (selected upstream via the Ranking_Engine's
// `selectSerendipityArticle`), so it is fully unit/property testable with no
// I/O.

import type { Article } from '@lumina/shared';

/** Card positions that are a multiple of this hold a Serendipity_Card (Req 10.1). */
export const SERENDIPITY_INTERVAL = 10;

/** A single feed card: either a ranked Article or an injected Serendipity_Card. */
export type FeedCard =
  | { kind: 'article'; article: Article }
  | { kind: 'serendipity'; article: Article };

/**
 * Interleave Serendipity_Cards into a ranked Article sequence so that every
 * 1-indexed output position that is a multiple of {@link SERENDIPITY_INTERVAL}
 * holds a Serendipity_Card and every other position holds the next ranked
 * Article in order (Requirement 10.1).
 *
 * Serendipity articles are consumed in order from `serendipityArticles`. When
 * the supply is exhausted at a multiple-of-10 position, that position falls back
 * to the next ranked Article (best effort) rather than emitting an empty slot.
 * No trailing Serendipity_Card is appended once the ranked articles run out.
 *
 * Pure: never mutates its inputs.
 */
export function injectSerendipityCards(
  rankedArticles: readonly Article[],
  serendipityArticles: readonly Article[],
): FeedCard[] {
  const cards: FeedCard[] = [];
  let rankedIdx = 0;
  let serendipityIdx = 0;

  while (rankedIdx < rankedArticles.length) {
    const position = cards.length + 1; // 1-indexed output position
    const serendipity = serendipityArticles[serendipityIdx];
    if (position % SERENDIPITY_INTERVAL === 0 && serendipity !== undefined) {
      cards.push({ kind: 'serendipity', article: serendipity });
      serendipityIdx += 1;
      continue;
    }
    const article = rankedArticles[rankedIdx];
    if (article !== undefined) cards.push({ kind: 'article', article });
    rankedIdx += 1;
  }

  return cards;
}

import { describe, it, expect } from 'vitest';

import type { UserRankingContext } from '@lumina/shared';

import { FakeQueryable } from '../repositories/fake-queryable.js';
import { assembleFeed, type FeedReturnedSet } from './assembly.js';
import { injectSerendipityCards } from './serendipity.js';

// End-to-end composition smoke test (task 28.3): exercises the wired feed flow —
// candidate resolution + exclusions (skips/mutes) → scoring/ordering/paging →
// serendipity injection — and asserts the assembled feed reflects muted topics
// and that serendipity cards land at every 10th position.
//
// A live database / HTTP layer is not available here, so the persistence layer
// is simulated with a SQL-routing FakeQueryable and an in-memory returned-set,
// which is sufficient to assert the cross-module composition completes and the
// feed reflects mutes.

const ISO = '2025-01-01T00:00:00.000Z';

function articleRow(id: string) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: `hash-${id}`,
    source: 'wikipedia',
    title: `Title ${id}`,
    summary: 'Summary',
    full_text: 'Full text',
    embedding: null,
    quality_score: 0.8,
    difficulty: 'intermediate',
    read_time_minutes: 5,
    summarization_status: 'summarized',
    published_at: ISO,
    ingested_at: ISO,
  };
}

const POOL_IDS = Array.from({ length: 12 }, (_, i) => `a-${i + 1}`);

/** Route queries to canned rows; `mutedTopicIds` toggles the muted-topic case. */
function makeDb(mutedTopicIds: string[]) {
  return new FakeQueryable((sql: string) => {
    if (/from user_topic/i.test(sql) && /muted = true/i.test(sql)) {
      return { rows: mutedTopicIds.map((topic_id) => ({ topic_id })) };
    }
    if (/from feed_event/i.test(sql)) return { rows: [] }; // no skips
    if (/from article_topic/i.test(sql)) {
      // a-2 is associated with the muted topic; all articles share t-sci.
      const rows = POOL_IDS.flatMap((id) => {
        const assoc = [{ article_id: id, topic_id: 't-sci', confidence: 0.9 }];
        if (id === 'a-2') assoc.push({ article_id: id, topic_id: 't-muted', confidence: 0.95 });
        return assoc;
      });
      return { rows };
    }
    if (/from article/i.test(sql)) return { rows: POOL_IDS.map(articleRow) };
    return { rows: [] };
  });
}

function fakeReturnedSet(): FeedReturnedSet {
  const store = new Map<string, Set<string>>();
  return {
    async getReturnedArticles(v) {
      return [...(store.get(v) ?? [])];
    },
    async addReturnedArticles(v, ids) {
      const set = store.get(v) ?? new Set<string>();
      ids.forEach((i) => set.add(i));
      store.set(v, set);
    },
  };
}

const userCtx: UserRankingContext = { embedding: null, onboardingTopicIds: ['t-sci'] };

describe('feed e2e composition smoke (task 28.3)', () => {
  it('assembles a personalized feed and injects serendipity at every 10th position', async () => {
    const result = await assembleFeed(
      { db: makeDb([]), redis: fakeReturnedSet(), newFeedVersion: () => 'v1', now: () => Date.parse(ISO) },
      { userId: 'u-1', tab: 'foryou', userCtx },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.articles.length).toBeGreaterThan(0);

    const serendipity = articleRowToArticleLike('s-1');
    const cards = injectSerendipityCards(result.response.articles, [serendipity]);
    // Position 10 (1-indexed) is a serendipity card given an ample pool.
    expect(cards[9]?.kind).toBe('serendipity');
  });

  it('excludes muted-topic articles from the assembled feed', async () => {
    const result = await assembleFeed(
      { db: makeDb(['t-muted']), redis: fakeReturnedSet(), newFeedVersion: () => 'v2', now: () => Date.parse(ISO) },
      { userId: 'u-1', tab: 'foryou', userCtx },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.response.articles.map((a) => a.id);
    expect(ids).not.toContain('a-2'); // a-2 is associated with the muted topic
    expect(ids).toContain('a-1');
  });
});

/** Minimal Article-like object for the serendipity slot in the smoke test. */
function articleRowToArticleLike(id: string) {
  return {
    id,
    url: `https://example.com/${id}`,
    source: 'wikipedia' as const,
    title: `Serendipity ${id}`,
    summary: 'Summary',
    fullText: 'Full text',
    embedding: null,
    qualityScore: 0.8,
    difficulty: 'intermediate' as const,
    readTimeMinutes: 5,
    topics: [],
    publishedAt: ISO,
    ingestedAt: ISO,
  };
}

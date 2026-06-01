import { describe, it, expect } from 'vitest';
import type { Article } from './domain.js';
import {
  selectSerendipityArticle,
  type SerendipitySelectionContext,
} from './ranking-engine.js';

// Example unit tests for serendipity article selection (task 11.7).
// The exhaustive property test "never-interacted-then-farthest rule" lives in
// task 11.8 (Property 20).

/**
 * Builds an Article with sensible defaults. The fields that matter for
 * serendipity selection are `id` (tie-breaking) and `topics` (Topic
 * association); the rest are filler so the type-checks pass.
 */
function makeArticle(id: string, topicIds: string[]): Article {
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
    topics: topicIds.map((topicId) => ({ topicId, confidence: 0.9 })),
    publishedAt: '2024-01-01T00:00:00.000Z',
    ingestedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makeCtx(overrides: Partial<SerendipitySelectionContext> = {}): SerendipitySelectionContext {
  return { userEmbedding: null, interactedTopicIds: [], ...overrides };
}

describe('selectSerendipityArticle — empty pool', () => {
  it('returns null for an empty candidate pool', () => {
    expect(selectSerendipityArticle(makeCtx(), [])).toBeNull();
  });
});

describe('selectSerendipityArticle — never-interacted topic (Requirement 10.2)', () => {
  it('selects an article from a topic the user has never interacted with', () => {
    const interactedArticle = makeArticle('a-interacted', ['t-known']);
    const freshArticle = makeArticle('b-fresh', ['t-new']);
    const ctx = makeCtx({ interactedTopicIds: ['t-known'] });

    const selected = selectSerendipityArticle(ctx, [interactedArticle, freshArticle]);
    expect(selected?.id).toBe('b-fresh');
  });

  it('prefers a candidate whose topics are entirely outside the interacted set', () => {
    // a-mixed has one never-interacted topic (t-new) but also an interacted one
    // (t-known); b-pure is entirely outside the interacted set and is preferred.
    const mixed = makeArticle('a-mixed', ['t-known', 't-new']);
    const pure = makeArticle('b-pure', ['t-fresh']);
    const ctx = makeCtx({ interactedTopicIds: ['t-known'] });

    const selected = selectSerendipityArticle(ctx, [mixed, pure]);
    expect(selected?.id).toBe('b-pure');
  });

  it('falls back to a partially-fresh candidate when none are entirely fresh', () => {
    // Both candidates include the interacted topic t-known, but each also has a
    // never-interacted topic, so phase 1 still applies (deterministic by id).
    const mixedA = makeArticle('a-mixed', ['t-known', 't-new1']);
    const mixedB = makeArticle('b-mixed', ['t-known', 't-new2']);
    const ctx = makeCtx({ interactedTopicIds: ['t-known'] });

    const selected = selectSerendipityArticle(ctx, [mixedB, mixedA]);
    expect(selected?.id).toBe('a-mixed'); // lowest id tie-break, order-independent
  });

  it('treats an article with no topics as belonging to no never-interacted topic', () => {
    // The topicless article never qualifies for phase 1; the fresh-topic
    // article does.
    const topicless = makeArticle('a-topicless', []);
    const fresh = makeArticle('b-fresh', ['t-new']);
    const ctx = makeCtx({ interactedTopicIds: [] });

    const selected = selectSerendipityArticle(ctx, [topicless, fresh]);
    expect(selected?.id).toBe('b-fresh');
  });

  it('treats every topic as never-interacted when the interacted set is empty', () => {
    const a = makeArticle('z-a', ['t1']);
    const b = makeArticle('m-b', ['t2']);
    const selected = selectSerendipityArticle(makeCtx(), [a, b]);
    expect(selected?.id).toBe('m-b'); // lowest id tie-break
  });
});

describe('selectSerendipityArticle — farthest centroid fallback (Requirement 10.3)', () => {
  it('selects an article from the topic whose centroid is farthest from the user embedding', () => {
    // The user has interacted with every topic, so phase 1 finds nothing and the
    // farthest-centroid rule applies. The user embedding points along +x.
    const near = makeArticle('a-near', ['t-near']);
    const far = makeArticle('b-far', ['t-far']);
    const ctx = makeCtx({
      userEmbedding: [1, 0],
      interactedTopicIds: ['t-near', 't-far'],
      topicCentroids: {
        't-near': [1, 0], // cosine similarity 1 (closest)
        't-far': [-1, 0], // cosine similarity -1 (farthest)
      },
    });

    const selected = selectSerendipityArticle(ctx, [near, far]);
    expect(selected?.id).toBe('b-far');
  });

  it('breaks centroid-distance ties by the lexicographically smallest topic id', () => {
    // Two topics are equally far (both orthogonal, similarity 0). The tie
    // resolves to the smaller topic id, "t-aaa".
    const articleA = makeArticle('z-article', ['t-bbb']);
    const articleB = makeArticle('y-article', ['t-aaa']);
    const ctx = makeCtx({
      userEmbedding: [1, 0],
      interactedTopicIds: ['t-aaa', 't-bbb'],
      topicCentroids: {
        't-aaa': [0, 1],
        't-bbb': [0, -1],
      },
    });

    const selected = selectSerendipityArticle(ctx, [articleA, articleB]);
    expect(selected?.id).toBe('y-article'); // the article in topic t-aaa
  });

  it('falls back deterministically across the pool when no usable centroid exists', () => {
    // All topics are interacted (phase 1 empty) and no centroids are supplied,
    // so the total fallback picks the lowest article id across the whole pool.
    const a = makeArticle('a-1', ['t1']);
    const b = makeArticle('c-2', ['t2']);
    const ctx = makeCtx({ userEmbedding: [1, 0], interactedTopicIds: ['t1', 't2'] });

    const selected = selectSerendipityArticle(ctx, [b, a]);
    expect(selected?.id).toBe('a-1');
  });

  it('falls back deterministically when the user has no embedding', () => {
    const a = makeArticle('a-1', ['t1']);
    const b = makeArticle('c-2', ['t2']);
    const ctx = makeCtx({
      userEmbedding: null,
      interactedTopicIds: ['t1', 't2'],
      topicCentroids: { t1: [1, 0], t2: [-1, 0] },
    });

    const selected = selectSerendipityArticle(ctx, [b, a]);
    expect(selected?.id).toBe('a-1'); // lowest id tie-break
  });

  it('skips topics whose centroid length differs from the user embedding', () => {
    // t-good has a matching-length, farthest centroid; t-bad has a mismatched
    // length and is ignored, so the article in t-good is selected.
    const good = makeArticle('a-good', ['t-good']);
    const bad = makeArticle('b-bad', ['t-bad']);
    const ctx = makeCtx({
      userEmbedding: [1, 0],
      interactedTopicIds: ['t-good', 't-bad'],
      topicCentroids: {
        't-good': [-1, 0], // matching length, farthest
        't-bad': [0, 0, 0], // mismatched length, skipped
      },
    });

    const selected = selectSerendipityArticle(ctx, [good, bad]);
    expect(selected?.id).toBe('a-good');
  });
});

describe('selectSerendipityArticle — purity', () => {
  it('does not mutate its inputs', () => {
    const pool = [makeArticle('a', ['t1']), makeArticle('b', ['t-new'])];
    const poolSnapshot = JSON.parse(JSON.stringify(pool));
    const ctx = makeCtx({
      userEmbedding: [1, 0],
      interactedTopicIds: ['t1'],
      topicCentroids: { t1: [1, 0] },
    });
    const interactedSnapshot = [...ctx.interactedTopicIds];

    selectSerendipityArticle(ctx, pool);

    expect(pool).toEqual(poolSnapshot);
    expect(ctx.interactedTopicIds).toEqual(interactedSnapshot);
  });
});

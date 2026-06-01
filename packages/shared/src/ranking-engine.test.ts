import { describe, it, expect } from 'vitest';
import type { Article } from './domain.js';
import { DEFAULT_RANKING_WEIGHTS } from './ranking.js';
import {
  EMBEDDING_DIMENSIONS,
  MAX_DIVERSITY_BONUS,
  computeComponents,
  diversity,
  diversityBonus,
  novelty,
  quality,
  recency,
  relevance,
  scoreArticle,
  serendipity,
  type SessionRankingContext,
  type UserRankingContext,
} from './ranking-engine.js';

// Basic example unit tests for the pure Ranking_Engine (task 11.1).
// The exhaustive property-based tests live in tasks 11.2, 11.3, 11.4.

function makeEmbedding(fill: (i: number) => number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => fill(i));
}

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'a1',
    url: 'https://example.com/a1',
    source: 'wikipedia',
    title: 'Title',
    summary: 'Summary',
    fullText: 'Full text',
    embedding: makeEmbedding(() => 1),
    qualityScore: 0.8,
    difficulty: 'intermediate',
    readTimeMinutes: 5,
    topics: [{ topicId: 't1', confidence: 0.9 }],
    publishedAt: '2024-01-01T00:00:00.000Z',
    ingestedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeUserCtx(overrides: Partial<UserRankingContext> = {}): UserRankingContext {
  return { embedding: null, onboardingTopicIds: [], ...overrides };
}

function makeSessionCtx(overrides: Partial<SessionRankingContext> = {}): SessionRankingContext {
  return {
    sourceCardCounts: {},
    avgCardsPerSource: 0,
    nowMs: Date.parse('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('recency (Requirement 9.3)', () => {
  it('is anchored at 1.0 for age 0 and 0.5 at the 24h half-life', () => {
    expect(recency(0)).toBe(1);
    expect(recency(24)).toBeCloseTo(0.5, 10);
    expect(recency(48)).toBeCloseTo(0.25, 10);
  });

  it('is monotonically non-increasing and approaches 0', () => {
    expect(recency(1)).toBeGreaterThan(recency(2));
    expect(recency(10_000)).toBeLessThan(0.001);
  });

  it('clamps non-positive (future) ages to 1.0', () => {
    expect(recency(-5)).toBe(1);
  });
});

describe('relevance (Requirements 9.2, 9.7)', () => {
  it('normalizes identical embeddings to 1.0 via (cos+1)/2', () => {
    const ctx = makeUserCtx({ embedding: makeEmbedding(() => 1) });
    const article = makeArticle({ embedding: makeEmbedding(() => 1) });
    expect(relevance(ctx, article)).toBeCloseTo(1, 10);
  });

  it('normalizes opposite embeddings to 0.0', () => {
    const ctx = makeUserCtx({ embedding: makeEmbedding(() => 1) });
    const article = makeArticle({ embedding: makeEmbedding(() => -1) });
    expect(relevance(ctx, article)).toBeCloseTo(0, 10);
  });

  it('normalizes orthogonal embeddings to the midpoint 0.5', () => {
    const ctx = makeUserCtx({ embedding: makeEmbedding((i) => (i === 0 ? 1 : 0)) });
    const article = makeArticle({ embedding: makeEmbedding((i) => (i === 1 ? 1 : 0)) });
    expect(relevance(ctx, article)).toBeCloseTo(0.5, 10);
  });

  it('falls back to the onboarding topic-match ratio when the user has no embedding', () => {
    const ctx = makeUserCtx({ embedding: null, onboardingTopicIds: ['t1', 'tX'] });
    const article = makeArticle({
      topics: [
        { topicId: 't1', confidence: 0.9 },
        { topicId: 't2', confidence: 0.5 },
      ],
    });
    // 1 of 2 article topics matches the onboarding set.
    expect(relevance(ctx, article)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 fallback relevance when the article has no topics', () => {
    const ctx = makeUserCtx({ embedding: null, onboardingTopicIds: ['t1'] });
    expect(relevance(ctx, makeArticle({ topics: [] }))).toBe(0);
  });
});

describe('novelty', () => {
  it('treats all topics as novel when the user has engaged with nothing', () => {
    expect(novelty(makeArticle(), [])).toBe(1);
  });

  it('is the fraction of unseen topics', () => {
    const article = makeArticle({
      topics: [
        { topicId: 't1', confidence: 1 },
        { topicId: 't2', confidence: 1 },
      ],
    });
    expect(novelty(article, ['t1'])).toBeCloseTo(0.5, 10);
  });
});

describe('quality', () => {
  it('returns the clamped article quality score', () => {
    expect(quality(makeArticle({ qualityScore: 0.42 }))).toBeCloseTo(0.42, 10);
  });
});

describe('diversityBonus and diversity (Requirement 9.5)', () => {
  it('grants no bonus when the source is at or above the average', () => {
    expect(diversityBonus(5, 5)).toBe(0);
    expect(diversityBonus(6, 5)).toBe(0);
  });

  it('grants a bonus within [0, 0.20] for under-represented sources', () => {
    const bonus = diversityBonus(0, 4);
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBeLessThanOrEqual(MAX_DIVERSITY_BONUS);
    expect(bonus).toBeCloseTo(MAX_DIVERSITY_BONUS, 10); // fully under-represented
  });

  it('returns no bonus when there is no session history', () => {
    expect(diversityBonus(0, 0)).toBe(0);
  });

  it('caps the diversity component at 1.0', () => {
    const article = makeArticle({ source: 'medium' });
    const session = makeSessionCtx({ sourceCardCounts: { medium: 0 }, avgCardsPerSource: 4 });
    const value = diversity(article, session);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeCloseTo(MAX_DIVERSITY_BONUS, 10);
  });
});

describe('serendipity', () => {
  it('is the complement of relevance', () => {
    const ctx = makeUserCtx({ embedding: makeEmbedding(() => 1) });
    const article = makeArticle({ embedding: makeEmbedding(() => 1) });
    expect(serendipity(ctx, article)).toBeCloseTo(0, 10);
  });
});

describe('scoreArticle (Requirements 9.1, 9.4)', () => {
  it('returns a score in [0, 1]', () => {
    const score = scoreArticle(makeArticle(), makeUserCtx(), makeSessionCtx());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('equals the weighted sum of the computed components', () => {
    const article = makeArticle();
    const userCtx = makeUserCtx({ embedding: makeEmbedding(() => 1), engagedTopicIds: [] });
    const session = makeSessionCtx({
      sourceCardCounts: { wikipedia: 0 },
      avgCardsPerSource: 4,
      nowMs: Date.parse('2024-01-02T00:00:00.000Z'), // 24h after publish
    });
    const c = computeComponents(article, userCtx, session);
    const w = DEFAULT_RANKING_WEIGHTS;
    const expected =
      c.relevance * w.relevance +
      c.novelty * w.novelty +
      c.quality * w.quality +
      c.recency * w.recency +
      c.diversity * w.diversity +
      c.serendipity * w.serendipity;
    expect(scoreArticle(article, userCtx, session)).toBeCloseTo(expected, 10);
  });
});

describe('computeComponents (Requirement 9.1)', () => {
  it('returns every component within [0, 1]', () => {
    const components = computeComponents(makeArticle(), makeUserCtx(), makeSessionCtx());
    for (const value of Object.values(components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

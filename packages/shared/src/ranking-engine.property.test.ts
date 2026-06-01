// Feature: lumina, Property 15: Ranking score and every component are bounded in [0,1]
//
// Property-based test for the pure Ranking_Engine in `./ranking-engine.ts`.
//
// Property 15 (design.md): For any candidate Article and user context —
// including the no-embedding fallback that uses the onboarding topic-match ratio
// and the cosine-to-[0,1] normalization `(cos + 1) / 2` — each of the six
// components (relevance, novelty, quality, recency, diversity, serendipity) and
// the final weighted-sum score lie within [0.0, 1.0].
//
// The generators below deliberately stress every branch of the engine:
//   - user embeddings that are present (1536-dim) or null (fallback path)
//   - article embeddings that are present (1536-dim) or null (fallback path)
//   - qualityScore values that are in-range, out-of-range, and non-finite
//     (to exercise the defensive clamp)
//   - publishedAt values in the past, in the future (negative age), and
//     unparseable (to exercise the recency clamp)
//   - varied topic associations, onboarding topics, and engaged topics
//   - varied per-source card counts, averages (including 0), and session clocks
//
// Each property runs a minimum of 100 generated iterations.
//
// Validates: Requirements 9.1, 9.2, 9.7.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Article } from './domain.js';
import { SOURCES } from './domain.js';
import {
  EMBEDDING_DIMENSIONS,
  computeComponents,
  scoreArticle,
  type SessionRankingContext,
  type UserRankingContext,
} from './ranking-engine.js';

const RUNS = { numRuns: 100 } as const;

// --- Generators ------------------------------------------------------------

// A finite real number with a wide-but-safe magnitude (no NaN, no Infinity).
const finiteNumber = fc.double({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

// A usable embedding: exactly EMBEDDING_DIMENSIONS finite numbers.
const embedding1536 = fc.array(finiteNumber, {
  minLength: EMBEDDING_DIMENSIONS,
  maxLength: EMBEDDING_DIMENSIONS,
});

// An embedding slot is either a full 1536-wide vector or null (fallback path).
const embeddingOrNull = fc.oneof(fc.constant(null), embedding1536);

// A small pool of topic ids so onboarding/engaged sets meaningfully overlap
// with article topics across iterations.
const topicId = fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8');

const topicAssociation = fc.record({
  topicId,
  confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

// 0..6 topic associations, including the empty case.
const topicAssociations = fc.array(topicAssociation, { minLength: 0, maxLength: 6 });

// qualityScore: in-range, out-of-range (both directions), and non-finite values,
// so the quality component clamp is exercised in every direction.
const qualityScore = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

// publishedAt: a parseable ISO timestamp (past or future) or an unparseable
// string, so the recency age computation and clamp are both exercised.
const publishedAt = fc.oneof(
  fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString()),
  fc.constantFrom('not-a-date', '', 'tomorrow'),
);

const article: fc.Arbitrary<Article> = fc.record({
  id: fc.constant('a1'),
  url: fc.constant('https://example.com/a1'),
  source: fc.constantFrom(...SOURCES),
  title: fc.constant('Title'),
  summary: fc.constant('Summary'),
  fullText: fc.constant('Full text'),
  embedding: embeddingOrNull,
  qualityScore,
  difficulty: fc.constant('intermediate'),
  readTimeMinutes: fc.integer({ min: 1, max: 120 }),
  topics: topicAssociations,
  publishedAt,
  ingestedAt: fc.constant('2024-01-01T00:00:00.000Z'),
});

const userCtx: fc.Arbitrary<UserRankingContext> = fc.record({
  embedding: embeddingOrNull,
  onboardingTopicIds: fc.array(topicId, { minLength: 0, maxLength: 8 }),
  engagedTopicIds: fc.array(topicId, { minLength: 0, maxLength: 8 }),
});

// Per-source card counts over the real source set (including absent sources).
const sourceCardCounts = fc.dictionary(
  fc.constantFrom(...SOURCES),
  fc.integer({ min: 0, max: 50 }),
);

const sessionCtx: fc.Arbitrary<SessionRankingContext> = fc.record({
  sourceCardCounts,
  // Includes 0 (no session history) and negative values to exercise the guard,
  // plus a normal positive range that drives the diversity bonus.
  avgCardsPerSource: fc.oneof(
    fc.constant(0),
    fc.double({ min: -5, max: 50, noNaN: true, noDefaultInfinity: true }),
  ),
  nowMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

// --- Assertions ------------------------------------------------------------

function expectInUnitInterval(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

describe('Property 15 - ranking score and every component are bounded in [0,1] (Req 9.1, 9.2, 9.7)', () => {
  it('keeps every component from computeComponents within [0, 1]', () => {
    fc.assert(
      fc.property(article, userCtx, sessionCtx, (a, u, s) => {
        const components = computeComponents(a, u, s);
        expectInUnitInterval(components.relevance);
        expectInUnitInterval(components.novelty);
        expectInUnitInterval(components.quality);
        expectInUnitInterval(components.recency);
        expectInUnitInterval(components.diversity);
        expectInUnitInterval(components.serendipity);
      }),
      RUNS,
    );
  });

  it('keeps the final weighted-sum score within [0, 1]', () => {
    fc.assert(
      fc.property(article, userCtx, sessionCtx, (a, u, s) => {
        expectInUnitInterval(scoreArticle(a, u, s));
      }),
      RUNS,
    );
  });

  it('keeps relevance bounded on the no-embedding onboarding fallback path', () => {
    // Force the fallback: user has no embedding, so relevance is the onboarding
    // topic-match ratio (Requirement 9.7) and must still lie in [0, 1].
    const fallbackUserCtx = fc.record({
      embedding: fc.constant(null),
      onboardingTopicIds: fc.array(topicId, { minLength: 0, maxLength: 8 }),
      engagedTopicIds: fc.array(topicId, { minLength: 0, maxLength: 8 }),
    });
    fc.assert(
      fc.property(article, fallbackUserCtx, sessionCtx, (a, u, s) => {
        const components = computeComponents(a, u, s);
        expectInUnitInterval(components.relevance);
        expectInUnitInterval(components.serendipity);
        expectInUnitInterval(scoreArticle(a, u, s));
      }),
      RUNS,
    );
  });
});

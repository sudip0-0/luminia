// Feature: lumina, Property 20: Serendipity selection follows the never-interacted-then-farthest rule
//
// Property-based test for `selectSerendipityArticle` in `./ranking-engine.ts`
// (task 11.7). The exhaustive example-based unit tests live alongside it in
// `./ranking-engine.serendipity.test.ts`.
//
// Property 20 (design.md): For any user and candidate pool, if a topic exists
// for which the user has no recorded Feed_Event against any associated article,
// the selected Serendipity_Card belongs to such a never-interacted topic
// (Requirement 10.2); otherwise it belongs to the topic whose centroid is
// farthest (largest cosine distance / lowest cosine similarity) from the
// User_Embedding (Requirement 10.3).
//
// This file exercises four facets of that rule, each over at least 100 generated
// iterations:
//   1. Phase 1 — when at least one candidate is associated with a topic the user
//      has never interacted with, the selection is drawn from such a topic.
//   2. Phase 2 — when every candidate topic has been interacted with and a usable
//      User_Embedding plus matching-length centroids are supplied, the selection
//      belongs to the topic whose centroid is farthest (lowest cosine similarity),
//      checked against an independently computed oracle.
//   3. Totality — `null` is returned only for an empty pool; for any non-empty
//      pool the result is always one of the supplied candidates.
//   4. Determinism — identical inputs always yield the identical selection.
//
// Validates: Requirements 10.2, 10.3.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Article } from './domain.js';
import {
  selectSerendipityArticle,
  type SerendipitySelectionContext,
} from './ranking-engine.js';

const RUNS = { numRuns: 200 } as const;

/** Embedding/centroid dimensionality used throughout the generators. */
const DIM = 4;

/** A fixed pool of topic ids so interacted sets and article topics overlap. */
const TOPIC_IDS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] as const;

// --- Builders --------------------------------------------------------------

/**
 * Builds an Article whose serendipity-relevant fields are `id` (tie-breaking and
 * pool membership) and `topics` (Topic associations); the rest are filler.
 */
function makeArticle(id: string, topicIds: readonly string[]): Article {
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

// --- Oracle (independent re-derivation for phase 2) ------------------------

/**
 * Cosine similarity of two equal-length vectors, mirroring the engine's own
 * convention: 0 when lengths differ, the array is empty, or either vector has
 * zero magnitude. Re-derived here so the phase-2 assertion does not depend on
 * the implementation under test.
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function isUsableCentroid(
  centroid: readonly number[] | null | undefined,
  dim: number,
): centroid is readonly number[] {
  return (
    Array.isArray(centroid) &&
    centroid.length === dim &&
    centroid.length > 0 &&
    centroid.every((n) => Number.isFinite(n))
  );
}

/**
 * Independently computes the topic among `poolTopicIds` whose centroid is
 * farthest (lowest cosine similarity) from `userEmbedding`, breaking ties by the
 * lexicographically smallest topic id. Returns `null` when no pool topic has a
 * usable matching-length centroid.
 */
function oracleFarthestTopic(
  userEmbedding: readonly number[],
  poolTopicIds: Iterable<string>,
  centroids: Readonly<Record<string, readonly number[] | null | undefined>>,
): string | null {
  let best: string | null = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const topicId of [...poolTopicIds].sort()) {
    const centroid = centroids[topicId];
    if (!isUsableCentroid(centroid, userEmbedding.length)) continue;
    const similarity = cosine(userEmbedding, centroid);
    if (similarity < lowest) {
      lowest = similarity;
      best = topicId;
    }
  }
  return best;
}

// --- Generators ------------------------------------------------------------

/** A finite vector of length `dim`. */
function fcVec(dim: number): fc.Arbitrary<number[]> {
  return fc.array(fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }), {
    minLength: dim,
    maxLength: dim,
  });
}

/**
 * A user embedding spanning every branch the selector must tolerate: absent
 * (`null`), a usable matching-length vector, a mismatched-length vector, and a
 * non-finite vector. Used by the general (totality/determinism) generators.
 */
const embeddingArb: fc.Arbitrary<number[] | null> = fc.oneof(
  fc.constant<number[] | null>(null),
  fcVec(DIM),
  fcVec(DIM - 1),
  fc.array(fc.constantFrom(Number.NaN, 0, 1), { minLength: DIM, maxLength: DIM }),
);

/** A single per-topic centroid: usable, mismatched length, absent, or non-finite. */
const centroidArb: fc.Arbitrary<readonly number[] | null> = fc.oneof(
  fcVec(DIM),
  fcVec(DIM + 1),
  fc.constant<readonly number[] | null>(null),
  fc.array(fc.constantFrom(Number.NaN, 0, 1), { minLength: DIM, maxLength: DIM }),
);

/** A map of per-topic centroids over (a subset of) the topic pool. */
const centroidsArb = fc.dictionary(fc.constantFrom(...TOPIC_IDS), centroidArb);

/** A list of 0-3 distinct topic ids for one article. */
const topicListArb = fc.uniqueArray(fc.constantFrom(...TOPIC_IDS), { minLength: 0, maxLength: 3 });

/** A general candidate pool (possibly empty) with unique article ids. */
const poolArb: fc.Arbitrary<Article[]> = fc
  .array(topicListArb, { minLength: 0, maxLength: 8 })
  .map((lists) => lists.map((topics, i) => makeArticle(`art-${i}`, topics)));

/** A general selection context mixing every embedding/centroid branch. */
const ctxArb: fc.Arbitrary<SerendipitySelectionContext> = fc.record({
  userEmbedding: embeddingArb,
  interactedTopicIds: fc.subarray([...TOPIC_IDS]),
  topicCentroids: centroidsArb,
});

/**
 * A phase-1 scenario: the interacted set leaves at least one fresh topic, and the
 * pool always contains a candidate associated with a never-interacted topic, so
 * Requirement 10.2 must apply regardless of the embedding/centroid inputs.
 */
const phase1Arb = fc
  .subarray([...TOPIC_IDS], { maxLength: TOPIC_IDS.length - 1 })
  .chain((interacted) => {
    const fresh = TOPIC_IDS.filter((t) => !interacted.includes(t)); // guaranteed non-empty
    return fc.record({
      interacted: fc.constant(interacted),
      // At least one article drawn entirely from never-interacted topics.
      freshTopics: fc.uniqueArray(fc.constantFrom(...fresh), {
        minLength: 1,
        maxLength: fresh.length,
      }),
      // Other arbitrary articles (any topics, possibly topicless).
      others: fc.array(topicListArb, { minLength: 0, maxLength: 6 }),
      userEmbedding: embeddingArb,
      topicCentroids: centroidsArb,
    });
  })
  .map(({ interacted, freshTopics, others, userEmbedding, topicCentroids }) => {
    const pool = [freshTopics, ...others].map((topics, i) => makeArticle(`art-${i}`, topics));
    const ctx: SerendipitySelectionContext = {
      userEmbedding,
      interactedTopicIds: interacted,
      topicCentroids,
    };
    return { ctx, pool, interacted };
  });

/**
 * A phase-2 scenario: every candidate topic has been interacted with (so phase 1
 * finds nothing), a usable User_Embedding is supplied, and every pool topic has a
 * matching-length centroid (so a farthest topic always exists). Centroids vary
 * per topic so the farthest topic is meaningfully distinguished.
 */
const phase2Arb = fc
  .record({
    userEmbedding: fcVec(DIM),
    topicLists: fc.array(
      fc.uniqueArray(fc.constantFrom(...TOPIC_IDS), { minLength: 1, maxLength: 3 }),
      { minLength: 1, maxLength: 8 },
    ),
  })
  .chain(({ userEmbedding, topicLists }) => {
    const used = [...new Set(topicLists.flat())]; // non-empty: every list has >=1 topic
    return fc.tuple(...used.map(() => fcVec(DIM))).map((vectors) => {
      const topicCentroids: Record<string, number[]> = {};
      used.forEach((topicId, idx) => {
        topicCentroids[topicId] = vectors[idx]!;
      });
      const pool = topicLists.map((topics, i) => makeArticle(`art-${i}`, topics));
      const ctx: SerendipitySelectionContext = {
        userEmbedding,
        interactedTopicIds: used, // all pool topics interacted => phase 1 empty
        topicCentroids,
      };
      return { ctx, pool };
    });
  });

// --- Properties ------------------------------------------------------------

describe('Property 20 - serendipity selection follows the never-interacted-then-farthest rule (Req 10.2, 10.3)', () => {
  it('phase 1: when a never-interacted topic exists, the selection belongs to such a topic (Req 10.2)', () => {
    fc.assert(
      fc.property(phase1Arb, ({ ctx, pool, interacted }) => {
        const selected = selectSerendipityArticle(ctx, pool);
        const interactedSet = new Set(interacted);
        expect(selected).not.toBeNull();
        // The chosen article must be associated with at least one topic the user
        // has never interacted with.
        expect(selected!.topics.some((assoc) => !interactedSet.has(assoc.topicId))).toBe(true);
      }),
      RUNS,
    );
  });

  it('phase 2: with all topics interacted, the selection belongs to the farthest-centroid topic (Req 10.3)', () => {
    fc.assert(
      fc.property(phase2Arb, ({ ctx, pool }) => {
        const selected = selectSerendipityArticle(ctx, pool);
        expect(selected).not.toBeNull();
        expect(pool).toContain(selected);

        const userEmbedding = ctx.userEmbedding!;
        const centroids = ctx.topicCentroids!;
        const poolTopicIds = new Set<string>();
        for (const article of pool) {
          for (const assoc of article.topics) poolTopicIds.add(assoc.topicId);
        }

        const farthest = oracleFarthestTopic(userEmbedding, poolTopicIds, centroids);
        // Every pool topic has a usable centroid in this scenario, so one exists.
        expect(farthest).not.toBeNull();

        // The selected article belongs to the independently computed farthest topic.
        expect(selected!.topics.some((assoc) => assoc.topicId === farthest)).toBe(true);

        // And that topic truly has the minimum cosine similarity (is farthest)
        // among all usable pool topics.
        const farSimilarity = cosine(userEmbedding, centroids[farthest!] as readonly number[]);
        for (const topicId of poolTopicIds) {
          const centroid = centroids[topicId];
          if (!isUsableCentroid(centroid, userEmbedding.length)) continue;
          expect(farSimilarity).toBeLessThanOrEqual(cosine(userEmbedding, centroid) + 1e-9);
        }
      }),
      RUNS,
    );
  });

  it('totality: returns null only for an empty pool; otherwise a candidate from the pool', () => {
    fc.assert(
      fc.property(ctxArb, poolArb, (ctx, pool) => {
        const selected = selectSerendipityArticle(ctx, pool);
        if (pool.length === 0) {
          expect(selected).toBeNull();
        } else {
          expect(selected).not.toBeNull();
          expect(pool).toContain(selected); // reference identity: drawn from the pool
        }
      }),
      RUNS,
    );
  });

  it('determinism: identical inputs always produce the identical selection', () => {
    fc.assert(
      fc.property(ctxArb, poolArb, (ctx, pool) => {
        const first = selectSerendipityArticle(ctx, pool);
        const second = selectSerendipityArticle(ctx, pool);
        // Both null, or the very same Article reference.
        expect(first).toBe(second);
      }),
      RUNS,
    );
  });
});

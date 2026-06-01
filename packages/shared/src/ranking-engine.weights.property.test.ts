// Feature: lumina, Property 17: Component weights always sum to 1.0
//
// Property-based test for the weight normalization performed by
// `applyBanditTuning(weights, relevanceAdjustment)` and for the
// `DEFAULT_RANKING_WEIGHTS`, both exported from `./ranking-engine.ts` /
// `./ranking.ts`. The enganged-topic bandit adjustment is clamped into the
// inclusive range [0.0, 0.15] (so NaN, negative, or oversized values are
// coerced into range), added to the relevance weight, and then every component
// weight is divided by the post-boost total so the six weights sum to exactly
// 1.0 (Requirements 9.4, 9.6).
//
// Property 17 (design.md): For any weight configuration — the defaults
// (0.35, 0.20, 0.20, 0.15, 0.05, 0.05) and any bandit-tuned weights where
// engaged-topic adjustments lie in [0.0, 0.15] — the six component weights sum
// to 1.0 after re-normalization.
//
// This file exercises three facets:
//   (1) DEFAULT_RANKING_WEIGHTS sums to 1.0.
//   (2) For any positive base weight set and any adjustment (including
//       out-of-range values that get clamped), the applyBanditTuning result
//       sums to 1.0 within a small epsilon.
//   (3) The (normalized) relevance weight does not decrease relative to its
//       normalized base when a positive adjustment is applied.
//
// Each generated property runs a minimum of 100 iterations.
//
// Validates: Requirements 9.4, 9.6

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyBanditTuning } from './ranking-engine.js';
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from './ranking.js';

const RUNS = { numRuns: 200 } as const;

// Tolerance for floating-point round-off accumulated across six divisions.
const EPSILON = 1e-9;

/** Sum of the six component weights. */
function sumWeights(w: RankingWeights): number {
  return w.relevance + w.novelty + w.quality + w.recency + w.diversity + w.serendipity;
}

// --- Generators ------------------------------------------------------------

// A single strictly-positive, finite weight spanning several orders of
// magnitude. Bounded away from 0 and from values large enough to overflow the
// post-boost total (which would trip the engine's non-finite guard and skip
// re-normalization). This keeps every generated weight set genuinely
// normalizable.
const positiveWeight = fc.double({
  min: 1e-6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

// An arbitrary set of six positive base weights (not necessarily summing to 1).
const baseWeights: fc.Arbitrary<RankingWeights> = fc.record({
  relevance: positiveWeight,
  novelty: positiveWeight,
  quality: positiveWeight,
  recency: positiveWeight,
  diversity: positiveWeight,
  serendipity: positiveWeight,
});

// An adjustment spanning the three regimes the clamp must handle:
//   - negative (clamped up to 0.0),
//   - in-range [0.0, 0.15] (used as-is),
//   - greater than 0.15 (clamped down to 0.15),
// plus the non-finite degenerate inputs the engine coerces into range.
const anyAdjustment = fc.oneof(
  fc.double({ min: -10, max: -1e-6, noNaN: true, noDefaultInfinity: true }), // negative
  fc.double({ min: 0, max: 0.15, noNaN: true, noDefaultInfinity: true }), // in range
  fc.double({ min: 0.15 + 1e-6, max: 10, noNaN: true, noDefaultInfinity: true }), // above range
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

// A strictly-positive adjustment that always yields a positive clamped boost:
// either in the upper part of the valid range or above it (clamped to 0.15).
const positiveAdjustment = fc.oneof(
  fc.double({ min: 1e-3, max: 0.15, noNaN: true, noDefaultInfinity: true }), // in range, positive
  fc.double({ min: 0.15 + 1e-6, max: 10, noNaN: true, noDefaultInfinity: true }), // above range -> 0.15
);

// --- Properties ------------------------------------------------------------

describe('Property 17 - component weights always sum to 1.0 (Req 9.4, 9.6)', () => {
  it('DEFAULT_RANKING_WEIGHTS sums to 1.0', () => {
    expect(sumWeights(DEFAULT_RANKING_WEIGHTS)).toBeCloseTo(1.0, 12);
  });

  it('any base weights + any (clamped) adjustment re-normalize to sum 1.0', () => {
    fc.assert(
      fc.property(baseWeights, anyAdjustment, (weights, adjustment) => {
        const tuned = applyBanditTuning(weights, adjustment);
        expect(sumWeights(tuned)).toBeCloseTo(1.0, 9);
        // Re-normalization must keep every weight finite and non-negative.
        for (const value of Object.values(tuned)) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }),
      RUNS,
    );
  });

  it('defaults re-normalize to sum 1.0 under any (clamped) adjustment', () => {
    fc.assert(
      fc.property(anyAdjustment, (adjustment) => {
        const tuned = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, adjustment);
        expect(sumWeights(tuned)).toBeCloseTo(1.0, 9);
      }),
      RUNS,
    );
  });

  it('relevance weight does not decrease vs its normalized base under a positive adjustment', () => {
    fc.assert(
      fc.property(baseWeights, positiveAdjustment, (weights, adjustment) => {
        const baseNormalizedRelevance = weights.relevance / sumWeights(weights);
        const tuned = applyBanditTuning(weights, adjustment);
        // Boosting relevance and re-normalizing can only raise (never lower)
        // relevance's normalized share, since every other weight is unchanged.
        expect(tuned.relevance).toBeGreaterThanOrEqual(baseNormalizedRelevance - EPSILON);
        // And the result still sums to 1.0.
        expect(sumWeights(tuned)).toBeCloseTo(1.0, 9);
      }),
      RUNS,
    );
  });
});

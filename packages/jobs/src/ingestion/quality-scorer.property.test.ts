// Feature: lumina, Property 6: Quality score is bounded and gates storage
//
// Property-based coverage for the Quality_Scorer (Requirements 6.3, 6.4).
//
// Property 6 (design.md): *For any* article, the quality score is within
// [0.0, 1.0], and the article is permitted to be stored if and only if its
// quality score is >= 0.3 (QUALITY_THRESHOLD).
//
// This file exercises three complementary sub-properties, each over a minimum
// of 100 generated iterations:
//
//   (1) Bounded score: for any generated input — a source drawn from the six
//       Sources, together with varied / out-of-range / non-finite wordCount and
//       readingGradeLevel — `scoreQuality` returns a finite value in [0.0, 1.0].
//   (2) Gate definition: for any generated score (including the exact boundary
//       0.3 and adversarial / non-finite values), `meetsQualityThreshold(score)`
//       equals `score >= 0.3`.
//   (3) Gate agreement: across generated inputs, the storage gate applied to a
//       real `scoreQuality` result agrees with comparing that score to 0.3.
//
// Implementation files are not modified; this test only observes the public
// quality-scorer API.
//
// Validates: Requirements 6.3, 6.4

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SOURCES } from '@lumina/shared';
import {
  QUALITY_THRESHOLD,
  scoreQuality,
  meetsQualityThreshold,
} from './quality-scorer.js';

const RUNS = { numRuns: 200 } as const;

// A number arbitrary that deliberately spans the full input space the scorer
// must tolerate: ordinary finite values, extreme magnitudes, negatives,
// out-of-range grades, and the non-finite values (NaN, ±Infinity) the scorer
// documents as defensively handled.
const messyNumber: fc.Arbitrary<number> = fc.oneof(
  // Ordinary, plausible finite values (e.g. word counts, grade levels).
  fc.double({ min: -1000, max: 100_000, noNaN: true }),
  // Extreme finite magnitudes to probe the asymptotic / clamping behaviour.
  fc.double({ noNaN: true }),
  // Explicit out-of-range and edge constants.
  fc.constantFrom(
    0,
    -0,
    -1,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER
  ),
  // Non-finite values the scorer must tolerate without producing NaN/Infinity.
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  )
);

const sourceArb = fc.constantFrom(...SOURCES);

const inputArb = fc.record({
  source: sourceArb,
  wordCount: messyNumber,
  readingGradeLevel: messyNumber,
});

// A score arbitrary covering the [0,1] range, the surrounding out-of-range
// region, the exact storage boundary 0.3, near-boundary values, and non-finite
// inputs — so the gate definition is checked precisely around the threshold.
const scoreArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -1, max: 2, noNaN: true }),
  fc.constantFrom(
    QUALITY_THRESHOLD, // exact boundary: 0.3
    QUALITY_THRESHOLD - Number.EPSILON,
    QUALITY_THRESHOLD + Number.EPSILON,
    0.29999999,
    0.30000001,
    0,
    1,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  )
);

describe('Property 6 - quality score is bounded and gates storage (Req 6.3, 6.4)', () => {
  it('(1) scoreQuality returns a finite value within [0.0, 1.0] for any input', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const score = scoreQuality(input);
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }),
      RUNS
    );
  });

  it('(2) meetsQualityThreshold(score) === (score >= 0.3) for any score', () => {
    fc.assert(
      fc.property(scoreArb, (score) => {
        expect(meetsQualityThreshold(score)).toBe(score >= QUALITY_THRESHOLD);
      }),
      RUNS
    );
  });

  it('(3) the storage gate agrees with scoreQuality across inputs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const score = scoreQuality(input);
        // The score is bounded (sub-property 1) and the gate is exactly the
        // threshold comparison, so storage is permitted iff score >= 0.3.
        expect(meetsQualityThreshold(score)).toBe(score >= QUALITY_THRESHOLD);
      }),
      RUNS
    );
  });
});

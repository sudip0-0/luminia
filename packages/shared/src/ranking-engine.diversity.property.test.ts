// Feature: lumina, Property 18: Diversity bonus is bounded and the component is capped
//
// Property-based test for the diversity scoring of the pure Ranking_Engine in
// `./ranking-engine.ts`.
//
// Property 18 (design.md): For any session card distribution, the diversity
// bonus added for an under-represented source lies within [0.0, 0.20], the
// bonus is applied only when that source has supplied fewer cards than the
// average per enabled source, and the resulting diversity component never
// exceeds 1.0.
//
// The generators below stress every branch of `diversityBonus` and `diversity`:
//   - source card counts including 0 and larger positive values
//   - averages including 0, negative values (the guard path), and positive
//     values (the linear-scaling path that drives the bonus)
//   - articles drawn from every supported source, with session card-count maps
//     that include and omit each source
//
// Each property runs a minimum of 100 generated iterations.
//
// Validates: Requirements 9.5.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Article } from './domain.js';
import { SOURCES } from './domain.js';
import {
  MAX_DIVERSITY_BONUS,
  diversity,
  diversityBonus,
  type SessionRankingContext,
} from './ranking-engine.js';

const RUNS = { numRuns: 100 } as const;

// --- Generators ------------------------------------------------------------

// Source card counts are non-negative quantities; include 0 alongside a wide
// integer and fractional range so both the equal and under-represented branches
// are exercised.
const sourceCardCount = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: 200 }),
  fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
);

// Averages span the guard path (0 and negative) and the active scaling path
// (positive). A strictly-positive variant is reused where the property needs
// avg > 0.
const positiveAvg = fc.double({ min: 0.5, max: 200, noNaN: true, noDefaultInfinity: true });
const avgCardsPerSource = fc.oneof(
  fc.constant(0),
  fc.double({ min: -50, max: 0, noNaN: true, noDefaultInfinity: true }),
  positiveAvg,
);

// A minimal Article whose only field relevant to `diversity` is `source`.
const article: fc.Arbitrary<Article> = fc.record({
  id: fc.constant('a1'),
  url: fc.constant('https://example.com/a1'),
  source: fc.constantFrom(...SOURCES),
  title: fc.constant('Title'),
  summary: fc.constant('Summary'),
  fullText: fc.constant('Full text'),
  embedding: fc.constant(null),
  qualityScore: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  difficulty: fc.constant('intermediate'),
  readTimeMinutes: fc.integer({ min: 1, max: 120 }),
  topics: fc.constant([]),
  publishedAt: fc.constant('2024-01-01T00:00:00.000Z'),
  ingestedAt: fc.constant('2024-01-01T00:00:00.000Z'),
});

// Per-source card counts over the real source set; the dictionary may omit some
// sources so the `?? 0` fallback in `diversity` is exercised too.
const sourceCardCounts = fc.dictionary(
  fc.constantFrom(...SOURCES),
  fc.integer({ min: 0, max: 200 }),
);

const sessionCtx: fc.Arbitrary<SessionRankingContext> = fc.record({
  sourceCardCounts,
  avgCardsPerSource,
  nowMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
});

// --- Assertions ------------------------------------------------------------

describe('Property 18 - diversity bonus is bounded and the component is capped (Req 9.5)', () => {
  it('keeps the diversity bonus within [0, 0.20] for any count/average', () => {
    fc.assert(
      fc.property(sourceCardCount, avgCardsPerSource, (count, avg) => {
        const bonus = diversityBonus(count, avg);
        expect(Number.isFinite(bonus)).toBe(true);
        expect(bonus).toBeGreaterThanOrEqual(0);
        expect(bonus).toBeLessThanOrEqual(MAX_DIVERSITY_BONUS);
      }),
      RUNS,
    );
  });

  it('applies the bonus only when the source is under-represented (count < avg)', () => {
    // avg is strictly positive here so the guard (avg <= 0 => 0) is not the
    // reason for a zero bonus; the count-vs-average comparison is what decides.
    fc.assert(
      fc.property(sourceCardCount, positiveAvg, (count, avg) => {
        const bonus = diversityBonus(count, avg);
        if (count >= avg) {
          // A source at or above the average gets no bonus.
          expect(bonus).toBe(0);
        } else {
          // An under-represented source gets a strictly positive bonus, still
          // capped at the maximum.
          expect(bonus).toBeGreaterThan(0);
          expect(bonus).toBeLessThanOrEqual(MAX_DIVERSITY_BONUS);
        }
      }),
      RUNS,
    );
  });

  it('keeps the diversity component within [0, 1] (never exceeds 1.0)', () => {
    fc.assert(
      fc.property(article, sessionCtx, (a, s) => {
        const component = diversity(a, s);
        expect(Number.isFinite(component)).toBe(true);
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });
});

// Feature: lumina, Property 16: Recency decay is monotonic and anchored
//
// Property-based test for the pure `recency(ageHours)` function exported from
// `./ranking-engine.ts`. The recency component is exponential decay of article
// age with a 24-hour half-life — `clamp01(0.5 ^ (ageHours / 24))` — yielding
// 1.0 at age 0, 0.5 at 24 hours, and approaching 0 as age grows. Ages at or
// before "now" (non-positive) clamp to 1.0 (Requirement 9.3).
//
// Property 16 (design.md): For any two article ages `a <= b` (hours),
// `recency(a) >= recency(b)`, with `recency(0) = 1.0`, `recency` strictly
// decreasing for positive ages, `recency(24) = 0.5` (24-hour half-life), and
// `recency` approaching 0 as age grows.
//
// This file exercises five facets of Property 16:
//   (1) monotonic non-increasing over any pair of generated ages a <= b
//   (2) anchored: recency(0) = 1.0
//   (3) half-life: recency(24) ≈ 0.5
//   (4) strictly decreasing for positive ages a < b
//   (5) large ages approach 0 (recency(age) < a small epsilon)
//
// Each generated property runs a minimum of 100 iterations.
//
// Validates: Requirements 9.3.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { recency } from './ranking-engine.js';

const RUNS = { numRuns: 200 } as const;

// --- Generators ------------------------------------------------------------

// Any finite age in hours, spanning negative (future-dated, clamps to 1.0),
// zero, and a wide positive range. Used for the monotonicity property, which
// must hold across the whole domain including the clamped region.
const anyAge = fc.double({
  min: -10_000,
  max: 100_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// A strictly positive age in a range comfortably above the double-underflow
// point of `0.5 ^ (age / 24)`, so distinct ages map to distinct recency values
// (the strict-decrease property would otherwise tie at 0 for huge ages).
const positiveAge = fc.double({
  min: 0.001,
  max: 200,
  noNaN: true,
  noDefaultInfinity: true,
});

// A strictly positive gap between two ages, kept within the same safe range so
// that b = a + delta stays comparable without underflowing to 0.
const positiveDelta = fc.double({
  min: 0.001,
  max: 200,
  noNaN: true,
  noDefaultInfinity: true,
});

// A large age (hours) where decay has driven recency far below any practical
// threshold; includes ages beyond the underflow point (recency exactly 0).
const largeAge = fc.double({
  min: 1_000,
  max: 10_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

// --- Properties ------------------------------------------------------------

describe('Property 16 - recency decay is monotonic and anchored (Req 9.3)', () => {
  it('is monotonic non-increasing: for a <= b, recency(a) >= recency(b)', () => {
    fc.assert(
      fc.property(anyAge, anyAge, (x, y) => {
        const [a, b] = x <= y ? [x, y] : [y, x];
        expect(recency(a)).toBeGreaterThanOrEqual(recency(b));
      }),
      RUNS,
    );
  });

  it('is anchored at age 0: recency(0) === 1.0', () => {
    expect(recency(0)).toBe(1.0);
  });

  it('has a 24-hour half-life: recency(24) ≈ 0.5', () => {
    expect(recency(24)).toBeCloseTo(0.5, 12);
  });

  it('is strictly decreasing for positive ages: for 0 < a < b, recency(a) > recency(b)', () => {
    fc.assert(
      fc.property(positiveAge, positiveDelta, (a, delta) => {
        const b = a + delta;
        expect(recency(a)).toBeGreaterThan(recency(b));
      }),
      RUNS,
    );
  });

  it('approaches 0 as age grows: large ages yield recency below a small epsilon', () => {
    const epsilon = 1e-6;
    fc.assert(
      fc.property(largeAge, (age) => {
        const value = recency(age);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(epsilon);
      }),
      RUNS,
    );
  });
});

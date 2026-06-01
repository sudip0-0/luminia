// Feature: lumina, Property 23: Scroll-depth events fire only on a 0.25 increase in maximum depth
//
// Property-based coverage for the Signal_Collector's scroll-depth emission
// logic (Requirement 12.6). The pure transition under test is
// `onScrollDepth(state, articleId, proportion, nowMs, idGen?)` in ./capture.ts.
//
// Property 23 (design.md): *For any* monotonic-or-noisy sequence of reader
// scroll proportions, a `scroll_depth` event is emitted exactly when the
// maximum scrolled proportion rises by at least 0.25 since the last emission,
// and each emitted event carries the new maximum.
//
// Strategy: feed a generated sequence of scroll proportions (including
// out-of-range, decreasing, and tiny-increment values) to `onScrollDepth`,
// threading the CaptureState across the whole sequence. An independent
// reference model tracks the last emitted maximum (starting at 0) and decides,
// for each input, whether an event should fire and what maximum it should
// carry. The clamp + threshold arithmetic is performed with the exact same
// operands as the implementation, so float comparisons match precisely. Each
// property runs a minimum of 100 generated iterations. Implementation files are
// not modified; this test only observes the public capture API.
//
// Validates: Requirements 12.6

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SCROLL_DEPTH_STEP,
  initialCaptureState,
  onScrollDepth,
} from './capture.js';
import type { CaptureState } from './capture.js';

const RUNS = { numRuns: 200 } as const;

const ART = 'article-1';

/**
 * Clamp onto [0,1] using the SAME arithmetic as the implementation's private
 * `clamp01`, so the reference model's clamped values are bit-identical to the
 * ones the production code computes.
 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Read the per-article recorded maximum, defaulting to 0 for an untracked article. */
function recordedMax(state: CaptureState, articleId: string): number {
  return state.articles[articleId]?.maxScrollProportion ?? 0;
}

/** Deterministic, sequential id generator so emitted clientEventIds are predictable. */
function sequentialIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

// Generator for a single scroll proportion. Mixes a wide continuous range
// (covering out-of-range negatives and >1 values) with hand-picked boundary
// values that exercise tiny increments and exact 0.25 steps.
const proportion: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  fc.constantFrom(
    -0.3, -0.01, 0, 0.01, 0.1, 0.2, 0.24, 0.2499, 0.25, 0.2501, 0.3, 0.49, 0.5,
    0.74, 0.75, 0.99, 1, 1.000001, 1.5,
  ),
);

// A sequence of proportions. Includes the empty sequence and long noisy runs.
const proportionSequence: fc.Arbitrary<number[]> = fc.array(proportion, {
  minLength: 0,
  maxLength: 60,
});

describe('Property 23 - scroll_depth fires only on a >=0.25 rise in max depth (Req 12.6)', () => {
  it('SCROLL_DEPTH_STEP is the 0.25 increment from the spec', () => {
    expect(SCROLL_DEPTH_STEP).toBe(0.25);
  });

  it('emits iff clamped proportion exceeds last emitted max by >=0.25, carrying the new max', () => {
    fc.assert(
      fc.property(proportionSequence, (proportions) => {
        const ids = sequentialIds();
        let state = initialCaptureState();

        // Reference model of the LAST EMITTED maximum (Property 23 baseline = 0).
        let lastEmittedMax = 0;
        // Independent count of emissions, to verify deterministic id minting.
        let emitCount = 0;
        // History of emitted maxima, to check monotonicity and >=0.25 spacing.
        const emittedMaxima: number[] = [];

        for (const p of proportions) {
          const clamped = clamp01(p);
          const shouldEmit = clamped - lastEmittedMax >= SCROLL_DEPTH_STEP;
          const prevMax = recordedMax(state, ART);

          const result = onScrollDepth(state, ART, p, 1_000, ids);

          // --- Emission decision matches the reference model exactly ---------
          expect(result.events).toHaveLength(shouldEmit ? 1 : 0);

          if (shouldEmit) {
            emitCount += 1;
            const event = result.events[0]!;

            // Shape: a scroll_depth event for this article.
            expect(event.type).toBe('scroll_depth');
            expect(event.articleId).toBe(ART);
            // Deterministic id from the injected generator (ids mint only on emit).
            expect(event.clientEventId).toBe(`id-${emitCount}`);

            // Carries the NEW maximum = the clamped incoming proportion.
            expect(event.payload.scrollProportion).toBe(clamped);

            // The recorded max advances to that new maximum.
            expect(recordedMax(result.state, ART)).toBe(clamped);

            lastEmittedMax = clamped;
            emittedMaxima.push(clamped);
          } else {
            // No emission -> state is returned unchanged (same reference) and the
            // recorded max is preserved.
            expect(result.state).toBe(state);
            expect(recordedMax(result.state, ART)).toBe(prevMax);
          }

          // The recorded max never decreases across any single transition.
          expect(recordedMax(result.state, ART)).toBeGreaterThanOrEqual(prevMax);

          state = result.state;
        }

        // --- Whole-sequence invariants on the emitted maxima ----------------
        // Emissions are strictly increasing and spaced at least 0.25 apart.
        for (let i = 1; i < emittedMaxima.length; i++) {
          expect(emittedMaxima[i]! - emittedMaxima[i - 1]!).toBeGreaterThanOrEqual(
            SCROLL_DEPTH_STEP,
          );
        }
        // The first emission (if any) is itself at least 0.25 (rise from 0).
        if (emittedMaxima.length > 0) {
          expect(emittedMaxima[0]!).toBeGreaterThanOrEqual(SCROLL_DEPTH_STEP);
        }
        // Final recorded max equals the last emitted max (or 0 if none emitted).
        expect(recordedMax(state, ART)).toBe(lastEmittedMax);
        // Recorded max is always within the clamped [0,1] scale.
        expect(recordedMax(state, ART)).toBeGreaterThanOrEqual(0);
        expect(recordedMax(state, ART)).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });

  it('never emits for non-increasing or below-step noise once a max is established', () => {
    // Focused property: after reaching some max, any proportion that does not
    // clear max + 0.25 (including decreases and out-of-range negatives) emits
    // nothing and leaves state untouched.
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.double({ min: -0.5, max: 1.5, noNaN: true }), { maxLength: 40 }),
        (seed, noise) => {
          const ids = sequentialIds();
          // Establish a recorded max by first crossing from 0.
          const established = clamp01(seed);
          let state = initialCaptureState();
          if (established >= SCROLL_DEPTH_STEP) {
            state = onScrollDepth(state, ART, established, 1_000, ids).state;
            expect(recordedMax(state, ART)).toBe(established);
          }

          for (const p of noise) {
            const clamped = clamp01(p);
            // Decide against the CURRENT recorded max, which may have advanced
            // on a previous genuine emit within this same noise run.
            const baseline = recordedMax(state, ART);
            const result = onScrollDepth(state, ART, p, 2_000, ids);
            if (clamped - baseline < SCROLL_DEPTH_STEP) {
              // Sub-step (or backward) movement: no event, state unchanged.
              expect(result.events).toHaveLength(0);
              expect(result.state).toBe(state);
            } else {
              // A genuine >=0.25 advance is allowed to emit and raise the max.
              expect(result.events).toHaveLength(1);
              expect(result.events[0]!.payload.scrollProportion).toBe(clamped);
            }
            state = result.state;
          }
        },
      ),
      RUNS,
    );
  });
});

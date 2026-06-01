// Feature: lumina, Property 22: Dwell duration classifies into exactly one of skip or dwell
//
// Property-based coverage for the Signal_Collector's dwell/skip classification
// (Requirements 12.4, 12.5).
//
// Property 22 (design.md): *For any* card visibility episode, if the card exits
// within 1500 ms of becoming >=50% visible the collector records a `skip` and no
// `dwell`; if it exits at or after 1500 ms it records exactly one `dwell` event
// carrying the tracked duration and no `skip`.
//
// A visible -> hidden cycle is driven through the pure transition functions
// `onCardVisible` then `onCardHidden`. For each generated (visibility-start,
// elapsed) pair the cycle must produce exactly ONE event, classified as:
//   - `skip`  iff elapsed < DWELL_THRESHOLD_MS (1500 ms), and
//   - `dwell` iff elapsed >= DWELL_THRESHOLD_MS,
// never both and never neither (for a card that was visible). A `dwell` event's
// `payload.dwellMs` equals the elapsed duration (clamped to >= 0 for clock skew).
//
// The generated elapsed spans both sides of the boundary and explicitly covers
// the exact 1500 ms boundary, 0, and small negative (clock-skew) offsets. A
// deterministic injected id generator keeps produced events predictable. No
// implementation files are modified; this test only observes the public API.
// Runs a minimum of 100 generated iterations per property.
//
// Validates: Requirements 12.4, 12.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DWELL_THRESHOLD_MS,
  initialCaptureState,
  onCardHidden,
  onCardVisible,
} from './capture.js';
import type { IdGenerator } from './capture.js';

const RUNS = { numRuns: 300 } as const;

const ARTICLE = 'article-prop-22';

/** Deterministic, sequential id generator so produced events are predictable. */
function sequentialIds(): IdGenerator {
  let n = 0;
  return () => `id-${++n}`;
}

// Visibility-start instant, kept well within the safe ISO range so occurredAt
// formatting never throws regardless of the elapsed offset added on hide.
const startMs = fc.integer({ min: 0, max: 2_000_000_000_000 });

// Elapsed offsets that straddle the 1500 ms boundary. We bias toward the
// boundary region (and pin the exact boundary, 0, and small negatives) so both
// the skip and dwell branches are exercised frequently rather than almost
// always landing on one side.
const elapsedMs = fc.oneof(
  // Anywhere across a wide range (covers far-below and far-above the boundary).
  fc.integer({ min: -5_000, max: 5_000_000 }),
  // Dense around the 1500 ms boundary to stress the < vs >= split.
  fc.integer({ min: DWELL_THRESHOLD_MS - 50, max: DWELL_THRESHOLD_MS + 50 }),
  // Pinned edge cases: the exact boundary, just below, just above, zero, skew.
  fc.constantFrom(
    DWELL_THRESHOLD_MS,
    DWELL_THRESHOLD_MS - 1,
    DWELL_THRESHOLD_MS + 1,
    0,
    -1,
    -1_000,
  ),
);

describe('Property 22 - dwell duration classifies into exactly one of skip or dwell (Req 12.4, 12.5)', () => {
  it('a visible->hidden cycle produces exactly one event: skip iff elapsed<1500, dwell iff elapsed>=1500', () => {
    fc.assert(
      fc.property(startMs, elapsedMs, (start, elapsed) => {
        const ids = sequentialIds();

        // Become >=50% visible at `start`: records the impression and starts the timer.
        const shown = onCardVisible(initialCaptureState(), ARTICLE, start, ids);
        expect(shown.events).toHaveLength(1);
        expect(shown.events[0]?.type).toBe('impression');

        // Exit the viewport `elapsed` ms later (elapsed may be negative => clock skew).
        const hideAt = start + elapsed;
        const { events } = onCardHidden(shown.state, ARTICLE, hideAt, ids);

        // Exactly ONE event is produced for a card that was visible.
        expect(events).toHaveLength(1);
        const event = events[0]!;

        // The single event is skip or dwell -- never any other type for this cycle.
        const isSkip = event.type === 'skip';
        const isDwell = event.type === 'dwell';
        expect(isSkip || isDwell).toBe(true);
        // Exactly one of the two classifications -- never both, never neither.
        expect(isSkip).toBe(!isDwell);

        // The dwell duration is the elapsed time clamped at >= 0 (clock skew -> 0).
        const expectedDwellMs = Math.max(0, elapsed);

        // Classification boundary: skip strictly below 1500 ms, dwell at/above.
        if (expectedDwellMs < DWELL_THRESHOLD_MS) {
          expect(event.type).toBe('skip');
        } else {
          expect(event.type).toBe('dwell');
        }

        // The event always carries the tracked (clamped) duration in ms.
        expect(event.payload.dwellMs).toBe(expectedDwellMs);
        expect(event.articleId).toBe(ARTICLE);
      }),
      RUNS,
    );
  });

  it('a dwell event (elapsed>=1500) carries dwellMs equal to the elapsed duration and emits no skip', () => {
    // Restrict the generator to the dwell side of the boundary, including the
    // exact 1500 ms boundary, to assert the duration is reported faithfully.
    const dwellElapsed = fc.integer({ min: DWELL_THRESHOLD_MS, max: 10_000_000 });

    fc.assert(
      fc.property(startMs, dwellElapsed, (start, elapsed) => {
        const ids = sequentialIds();
        const shown = onCardVisible(initialCaptureState(), ARTICLE, start, ids);
        const { events } = onCardHidden(shown.state, ARTICLE, start + elapsed, ids);

        expect(events).toHaveLength(1);
        expect(events.filter((e) => e.type === 'skip')).toHaveLength(0);
        const event = events[0]!;
        expect(event.type).toBe('dwell');
        expect(event.payload.dwellMs).toBe(elapsed);
      }),
      RUNS,
    );
  });

  it('a skip event (elapsed<1500, clamped) carries dwellMs in [0,1500) and emits no dwell', () => {
    // Restrict to the skip side: elapsed strictly below the boundary, plus
    // negatives that clamp to 0.
    const skipElapsed = fc.integer({ min: -10_000, max: DWELL_THRESHOLD_MS - 1 });

    fc.assert(
      fc.property(startMs, skipElapsed, (start, elapsed) => {
        const ids = sequentialIds();
        const shown = onCardVisible(initialCaptureState(), ARTICLE, start, ids);
        const { events } = onCardHidden(shown.state, ARTICLE, start + elapsed, ids);

        expect(events).toHaveLength(1);
        expect(events.filter((e) => e.type === 'dwell')).toHaveLength(0);
        const event = events[0]!;
        expect(event.type).toBe('skip');
        const dwellMs = event.payload.dwellMs as number;
        expect(dwellMs).toBe(Math.max(0, elapsed));
        expect(dwellMs).toBeGreaterThanOrEqual(0);
        expect(dwellMs).toBeLessThan(DWELL_THRESHOLD_MS);
      }),
      RUNS,
    );
  });
});

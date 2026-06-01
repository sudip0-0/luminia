// Feature: lumina, Property 35: The daily-goal arc is the capped progress ratio
//
// Property-based test for the daily-goal arc logic in `./sessionManager.ts`.
//
// Property 35 (design.md): For any accumulated reading minutes `m` and daily
// goal `g`, the arc fill equals `min(m / g, 1.0)`; it never exceeds 1.0 and
// never wraps, remaining fully filled while `m >= g` until the next
// local-midnight reset.
//
// The Session_Manager transitions are pure value-to-value mappings, so the arc
// behaviour can be exercised exhaustively without a UI:
//   - tickReadingTime always adds the (non-negative) reading delta, but only
//     recomputes the visible arc when at least ARC_UPDATE_INTERVAL_MS (60s)
//     have elapsed since the last recompute. The very first tick of a session
//     always recomputes because lastArcUpdateAt starts null.
//   - When it recomputes, arc = min(accumulatedMinutes / dailyGoal, 1).
//   - At/above the goal the arc stays exactly 1 without wrapping.
//
// To exercise the arc we must respect the 60s throttle: each driven tick below
// advances `now` by >= ARC_UPDATE_INTERVAL_MS so the arc actually recomputes.
// Start times are anchored to a safe local hour and advances are bounded so the
// driven ticks never cross a local-midnight boundary (which is a separate
// daily-reset behaviour, Requirement 16.4).
//
// Each property runs a minimum of 100 generated iterations.
//
// Validates: Requirements 16.1, 16.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ARC_UPDATE_INTERVAL_MS,
  isDailyGoalAchieved,
  startSession,
  tickReadingTime,
  type SessionState,
} from './sessionManager.js';

const RUNS = { numRuns: 200 } as const;

// --- Generators ------------------------------------------------------------

// A Daily_Goal within the documented 5-120 minute range (the arc denominator).
const dailyGoal = fc.integer({ min: 5, max: 120 });

// A positive reading delta in minutes. The upper bound comfortably exceeds the
// maximum goal (120) so generated runs routinely reach and cross the cap.
const deltaMinutes = fc.integer({ min: 1, max: 300 });

// A varied start instant anchored to 08:00 on some local day. Using the
// local-time Date constructor keeps the day key timezone-independent for the
// test runner, and the 08:00 anchor leaves many hours of headroom before the
// next local midnight, so the bounded advances below never roll the day over.
const startNow = fc
  .integer({ min: 0, max: 1000 })
  .map((dayOffset) => new Date(2024, 0, 1 + dayOffset, 8, 0, 0).getTime());

// An advance that crosses the 60s update boundary, forcing the arc to recompute
// on the next tick. Capped at 6 hours so a single advance stays within the day.
const recomputeAdvanceMs = fc.integer({
  min: ARC_UPDATE_INTERVAL_MS,
  max: 6 * 60 * 60 * 1000,
});

// A per-tick advance that crosses the boundary, bounded so that even a long
// sequence of ticks (<= 30) stays within the same local day (30 * 2min = 1h).
const tickAdvanceMs = fc.integer({
  min: ARC_UPDATE_INTERVAL_MS,
  max: 2 * ARC_UPDATE_INTERVAL_MS,
});

function freshSession(goal: number, now: number): SessionState {
  return startSession({ dailyGoalMinutes: goal, now });
}

describe('Session_Manager daily-goal arc — Property 35 (Requirements 16.1, 16.5)', () => {
  // Property 35 (1): once the arc updates (tick crosses the 60s boundary), the
  // arc equals the capped progress ratio min(accumulated / goal, 1) and always
  // lies within [0, 1].
  it('fills the arc to min(accumulated / goal, 1) after a recompute, bounded to [0, 1] (16.1)', () => {
    fc.assert(
      fc.property(
        dailyGoal,
        deltaMinutes,
        startNow,
        recomputeAdvanceMs,
        (goal, delta, start, advance) => {
          const s0 = freshSession(goal, start);
          // The first tick always recomputes (lastArcUpdateAt is null); advance
          // past the boundary as well so the recompute is unambiguous.
          const s1 = tickReadingTime(s0, { deltaMinutes: delta, now: start + advance });

          expect(s1.accumulatedMinutes).toBe(delta);
          // Identical float operation to the implementation -> exact equality.
          expect(s1.arc).toBe(Math.min(delta / goal, 1));
          expect(s1.arc).toBeGreaterThanOrEqual(0);
          expect(s1.arc).toBeLessThanOrEqual(1);
        },
      ),
      RUNS,
    );
  });

  // Property 35 (2): when accumulated reading time is at or above the goal, the
  // arc is exactly 1 — full, never wrapping past 1 no matter how far over.
  it('caps the arc at exactly 1 (no wrapping) when accumulated >= goal (16.5)', () => {
    fc.assert(
      fc.property(
        dailyGoal,
        // A delta guaranteed to meet or exceed the goal (goal..goal+overflow).
        fc.integer({ min: 0, max: 400 }),
        startNow,
        recomputeAdvanceMs,
        (goal, overflow, start, advance) => {
          const delta = goal + overflow; // accumulated >= goal
          const s0 = freshSession(goal, start);
          const s1 = tickReadingTime(s0, { deltaMinutes: delta, now: start + advance });

          expect(s1.accumulatedMinutes).toBe(delta);
          expect(s1.arc).toBe(1);
          expect(isDailyGoalAchieved(s1)).toBe(true);

          // A further recompute keeps it pinned at 1 without wrapping.
          const s2 = tickReadingTime(s1, {
            deltaMinutes: overflow,
            now: start + advance + ARC_UPDATE_INTERVAL_MS,
          });
          expect(s2.arc).toBe(1);
        },
      ),
      RUNS,
    );
  });

  // Property 35 (3): the 60s throttle is respected, and once the arc updates it
  // tracks the capped ratio of the *recomputed* accumulated total. A tick that
  // does NOT cross the boundary accumulates minutes but leaves the arc as-is;
  // the next boundary-crossing tick catches the arc up to min(total / goal, 1).
  it('holds the arc within the 60s window then recomputes min(accumulated / goal, 1) (16.1)', () => {
    fc.assert(
      fc.property(
        dailyGoal,
        deltaMinutes,
        deltaMinutes,
        startNow,
        recomputeAdvanceMs,
        (goal, firstDelta, secondDelta, start, advance) => {
          // First tick recomputes (lastArcUpdateAt null) -> arc reflects firstDelta.
          const s1 = tickReadingTime(freshSession(goal, start), {
            deltaMinutes: firstDelta,
            now: start,
          });
          const arcAfterFirst = Math.min(firstDelta / goal, 1);
          expect(s1.arc).toBe(arcAfterFirst);

          // Second tick is within the 60s window: minutes accumulate, arc holds.
          const within = tickReadingTime(s1, {
            deltaMinutes: secondDelta,
            now: start + (ARC_UPDATE_INTERVAL_MS - 1),
          });
          expect(within.accumulatedMinutes).toBe(firstDelta + secondDelta);
          expect(within.arc).toBe(arcAfterFirst);

          // Crossing the boundary recomputes against the full accumulated total.
          const recomputed = tickReadingTime(within, {
            deltaMinutes: 0,
            now: start + advance,
          });
          const total = firstDelta + secondDelta;
          expect(recomputed.accumulatedMinutes).toBe(total);
          expect(recomputed.arc).toBe(Math.min(total / goal, 1));
          expect(recomputed.arc).toBeGreaterThanOrEqual(0);
          expect(recomputed.arc).toBeLessThanOrEqual(1);
        },
      ),
      RUNS,
    );
  });

  // Property 35 (combined): a model-based check over a sequence of
  // boundary-crossing ticks. A reference model accumulates minutes the same way
  // the implementation does and asserts arc == min(accumulated / goal, 1) and
  // 0 <= arc <= 1 after every recompute, with no day rollover in the window.
  it('matches a reference capped-ratio model across a sequence of recomputing ticks (16.1, 16.5)', () => {
    fc.assert(
      fc.property(
        dailyGoal,
        startNow,
        fc.array(fc.tuple(deltaMinutes, tickAdvanceMs), { minLength: 1, maxLength: 30 }),
        (goal, start, ticks) => {
          let state = freshSession(goal, start);
          let now = start;
          let accumulated = 0;

          for (const [delta, advance] of ticks) {
            now += advance; // always >= 60s -> the arc recomputes each tick
            state = tickReadingTime(state, { deltaMinutes: delta, now });
            accumulated += delta; // mirror the implementation's accumulation order

            const expectedArc = Math.min(accumulated / goal, 1);
            expect(state.accumulatedMinutes).toBe(accumulated);
            expect(state.arc).toBe(expectedArc);
            expect(state.arc).toBeGreaterThanOrEqual(0);
            expect(state.arc).toBeLessThanOrEqual(1);
            // Once at/above the goal the arc is pinned full without wrapping.
            if (accumulated >= goal) {
              expect(state.arc).toBe(1);
            }
          }
        },
      ),
      RUNS,
    );
  });
});

// Feature: lumina, Property 34: Soft feed end triggers at 30 cards and resets on continue
//
// Property-based test for the pure soft-feed-end logic in `./sessionManager.ts`.
//
// Property 34 (design.md): For any sequence of card-entry events in a session,
// the session-end screen is presented exactly when the cumulative count of
// cards that entered the viewport reaches 30; tapping "Keep going" resets the
// count to 0 so that the next session-end occurs after another 30 cards.
//
// The Session_Manager transitions are pure value-to-value mappings, so the
// behaviour can be exercised exhaustively without a UI:
//   - onCardEntered increments the per-session viewed count and flags the
//     session-end screen once the count reaches SESSION_CARD_LIMIT (30). While
//     the screen is presented it is a no-op, so the count never climbs past 30.
//   - canLoadMore is the negation of sessionEndPresented (loading is blocked
//     precisely while the session-end screen is up).
//   - keepGoing dismisses the screen and resets the count to 0, re-arming the
//     same 30-card trigger.
//
// Each property below runs a minimum of 100 generated iterations, with varied
// sequences that interleave "card entered" and "keep going" events.
//
// Validates: Requirements 15.2, 15.4

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SESSION_CARD_LIMIT,
  canLoadMore,
  keepGoing,
  onCardEntered,
  startSession,
  type SessionState,
} from './sessionManager.js';

const RUNS = { numRuns: 200 } as const;

// --- Generators ------------------------------------------------------------

// A Daily_Goal within the documented 5–120 minute range. The soft-feed-end
// fields are independent of the daily-goal arc, but we vary the goal so the
// session is constructed across the full valid space.
const goalMinutes = fc.integer({ min: 5, max: 120 });

// A positive wall-clock epoch (ms). Only affects the unrelated dailyResetDate.
const nowMs = fc.integer({ min: 0, max: 2_000_000_000_000 });

// A fresh session (viewedCount 0, screen dismissed) over varied goal/clock.
const freshSession = fc
  .tuple(goalMinutes, nowMs)
  .map(([dailyGoalMinutes, now]): SessionState => startSession({ dailyGoalMinutes, now }));

// A varied command stream. Cards are weighted heavier than "keep going" so the
// generated sequences routinely cross the 30-card limit and re-arm afterwards.
type Command = { readonly type: 'card' } | { readonly type: 'keepGoing' };
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<Command>({ type: 'card' }) },
  { weight: 1, arbitrary: fc.constant<Command>({ type: 'keepGoing' }) },
);
// Up to 120 commands → easily multiple 30-card cycles with interleaved resets.
const commandSequence = fc.array(command, { minLength: 0, maxLength: 120 });

describe('Session_Manager soft feed end — Property 34 (Requirements 15.2, 15.4)', () => {
  // Property 34 (1): presentation is true iff the cumulative viewed count has
  // reached SESSION_CARD_LIMIT. Because card-entered is a no-op once presented,
  // the screen appears exactly at 30 and stays, and the count never exceeds 30.
  it('presents the session-end screen exactly when the viewed count reaches 30 and stays (15.2)', () => {
    fc.assert(
      fc.property(freshSession, fc.integer({ min: 0, max: 90 }), (start, cardCount) => {
        let state = start;
        for (let entered = 1; entered <= cardCount; entered++) {
          state = onCardEntered(state);
          const expectedCount = Math.min(entered, SESSION_CARD_LIMIT);
          // Invariant maintained after every single card-entered event.
          expect(state.viewedCount).toBe(expectedCount);
          expect(state.sessionEndPresented).toBe(expectedCount >= SESSION_CARD_LIMIT);
        }
        // Final state: presented iff at least 30 cards entered; count capped at 30.
        expect(state.sessionEndPresented).toBe(cardCount >= SESSION_CARD_LIMIT);
        expect(state.viewedCount).toBe(Math.min(cardCount, SESSION_CARD_LIMIT));
      }),
      RUNS,
    );
  });

  // Property 34 (2): loading is blocked precisely while the screen is shown.
  // Checked as an invariant across arbitrary card/keep-going sequences.
  it('allows loading iff the session-end screen is not presented (15.2, 15.4)', () => {
    fc.assert(
      fc.property(freshSession, commandSequence, (start, commands) => {
        let state = start;
        expect(canLoadMore(state)).toBe(!state.sessionEndPresented);
        for (const cmd of commands) {
          state = cmd.type === 'card' ? onCardEntered(state) : keepGoing(state);
          expect(canLoadMore(state)).toBe(!state.sessionEndPresented);
        }
      }),
      RUNS,
    );
  });

  // Property 34 (3): "Keep going" resets the count to 0, dismisses the screen,
  // and re-arms the trigger so the next session-end occurs after another 30
  // cards. Generated from a saturated session followed by a fresh card run.
  it('resets on "Keep going" and re-triggers after another 30 cards (15.4)', () => {
    fc.assert(
      fc.property(
        freshSession,
        // Enough cards to reach (and exceed) the limit before keepGoing.
        fc.integer({ min: SESSION_CARD_LIMIT, max: SESSION_CARD_LIMIT + 25 }),
        // The second run length, spanning below, at, and above the limit.
        fc.integer({ min: 0, max: 60 }),
        (start, firstRun, secondRun) => {
          let state = start;
          for (let i = 0; i < firstRun; i++) state = onCardEntered(state);
          expect(state.sessionEndPresented).toBe(true);

          // Keep going resets the per-session counter and dismisses the screen.
          state = keepGoing(state);
          expect(state.viewedCount).toBe(0);
          expect(state.sessionEndPresented).toBe(false);
          expect(canLoadMore(state)).toBe(true);

          // The 30-card trigger is fully re-armed for the next run.
          for (let entered = 1; entered <= secondRun; entered++) {
            state = onCardEntered(state);
            const expectedCount = Math.min(entered, SESSION_CARD_LIMIT);
            expect(state.viewedCount).toBe(expectedCount);
            expect(state.sessionEndPresented).toBe(expectedCount >= SESSION_CARD_LIMIT);
          }
          expect(state.sessionEndPresented).toBe(secondRun >= SESSION_CARD_LIMIT);
        },
      ),
      RUNS,
    );
  });

  // Property 34 (combined): a model-based check over fully varied sequences that
  // interleave card-entered and keep-going events. A tiny reference model tracks
  // the expected count/presentation and is compared after every transition.
  it('matches a reference model across interleaved card and "Keep going" events (15.2, 15.4)', () => {
    fc.assert(
      fc.property(freshSession, commandSequence, (start, commands) => {
        let state = start;
        let modelCount = state.viewedCount;
        let modelPresented = state.sessionEndPresented;

        for (const cmd of commands) {
          if (cmd.type === 'card') {
            state = onCardEntered(state);
            if (!modelPresented) {
              modelCount += 1;
              modelPresented = modelCount >= SESSION_CARD_LIMIT;
            }
          } else {
            state = keepGoing(state);
            modelCount = 0;
            modelPresented = false;
          }
          expect(state.viewedCount).toBe(modelCount);
          expect(state.sessionEndPresented).toBe(modelPresented);
          expect(canLoadMore(state)).toBe(!modelPresented);
          // The count is always within [0, 30] — it never overshoots the limit.
          expect(state.viewedCount).toBeGreaterThanOrEqual(0);
          expect(state.viewedCount).toBeLessThanOrEqual(SESSION_CARD_LIMIT);
        }
      }),
      RUNS,
    );
  });
});

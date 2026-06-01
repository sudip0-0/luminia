import { describe, it, expect } from 'vitest';
import {
  ARC_UPDATE_INTERVAL_MS,
  SESSION_CARD_LIMIT,
  canLoadMore,
  endSession,
  isDailyGoalAchieved,
  keepGoing,
  localDateKey,
  onCardEntered,
  onLocalMidnight,
  startSession,
  tickReadingTime,
  type SessionState,
} from './sessionManager.js';

// A fixed local-day reference (use local-time constructor so the date key is
// timezone-independent for the test runner).
const DAY1 = new Date(2024, 0, 15, 9, 0, 0).getTime(); // 2024-01-15 09:00 local
const DAY2 = new Date(2024, 0, 16, 0, 0, 0).getTime(); // 2024-01-16 00:00 local

function freshSession(goal = 15, now = DAY1): SessionState {
  return startSession({ dailyGoalMinutes: goal, now });
}

describe('Session_Manager soft feed end (Requirement 15)', () => {
  it('starts a session with a zeroed viewed-card count (15.1)', () => {
    const s = freshSession();
    expect(s.viewedCount).toBe(0);
    expect(s.sessionEndPresented).toBe(false);
    expect(canLoadMore(s)).toBe(true);
  });

  it('presents the session-end screen exactly at 30 cards (15.2)', () => {
    let s = freshSession();
    for (let i = 0; i < SESSION_CARD_LIMIT - 1; i++) {
      s = onCardEntered(s);
      expect(s.sessionEndPresented).toBe(false);
    }
    s = onCardEntered(s);
    expect(s.viewedCount).toBe(SESSION_CARD_LIMIT);
    expect(s.sessionEndPresented).toBe(true);
  });

  it('prevents further loading while the session-end screen is shown (15.3)', () => {
    let s = freshSession();
    for (let i = 0; i < SESSION_CARD_LIMIT; i++) {
      s = onCardEntered(s);
    }
    expect(canLoadMore(s)).toBe(false);
    // Additional card-entered inputs are no-ops past the limit.
    const after = onCardEntered(s);
    expect(after).toEqual(s);
    expect(after.viewedCount).toBe(SESSION_CARD_LIMIT);
  });

  it('resets the count and resumes loading on "Keep going" (15.4)', () => {
    let s = freshSession();
    for (let i = 0; i < SESSION_CARD_LIMIT; i++) {
      s = onCardEntered(s);
    }
    s = keepGoing(s);
    expect(s.viewedCount).toBe(0);
    expect(s.sessionEndPresented).toBe(false);
    expect(canLoadMore(s)).toBe(true);
  });

  it('ends the session on feed exit, clearing per-session counters (15.5)', () => {
    let s = freshSession();
    s = onCardEntered(onCardEntered(s));
    const ended = endSession(s);
    expect(ended.viewedCount).toBe(0);
    expect(ended.sessionEndPresented).toBe(false);
  });

  it('preserves daily progress across keepGoing and endSession', () => {
    let s = freshSession(20);
    s = tickReadingTime(s, { deltaMinutes: 5, now: DAY1 });
    const kept = keepGoing(s);
    const ended = endSession(s);
    expect(kept.accumulatedMinutes).toBe(5);
    expect(ended.accumulatedMinutes).toBe(5);
  });
});

describe('Session_Manager daily-goal arc (Requirement 16)', () => {
  it('fills the arc to min(accumulated / goal, 1) on the first tick (16.1)', () => {
    const s = tickReadingTime(freshSession(20), { deltaMinutes: 5, now: DAY1 });
    expect(s.accumulatedMinutes).toBe(5);
    expect(s.arc).toBeCloseTo(0.25, 10);
  });

  it('caps the arc at 1.0 at or above the goal without wrapping (16.2, 16.5)', () => {
    const s = tickReadingTime(freshSession(15), { deltaMinutes: 40, now: DAY1 });
    expect(s.arc).toBe(1);
    expect(isDailyGoalAchieved(s)).toBe(true);
  });

  it('recomputes the arc at most once per 60 seconds (16.1)', () => {
    let s = tickReadingTime(freshSession(60), { deltaMinutes: 10, now: DAY1 });
    expect(s.arc).toBeCloseTo(10 / 60, 10);

    // A second tick before 60s elapses accumulates minutes but holds the arc.
    s = tickReadingTime(s, { deltaMinutes: 10, now: DAY1 + 30_000 });
    expect(s.accumulatedMinutes).toBe(20);
    expect(s.arc).toBeCloseTo(10 / 60, 10);

    // After 60s elapses the arc catches up to the accumulated total.
    s = tickReadingTime(s, { deltaMinutes: 0, now: DAY1 + ARC_UPDATE_INTERVAL_MS });
    expect(s.arc).toBeCloseTo(20 / 60, 10);
  });

  it('resets accumulated time and clears the arc at local midnight (16.4)', () => {
    let s = tickReadingTime(freshSession(15), { deltaMinutes: 15, now: DAY1 });
    expect(s.arc).toBe(1);
    s = onLocalMidnight(s, DAY2);
    expect(s.accumulatedMinutes).toBe(0);
    expect(s.arc).toBe(0);
    expect(s.dailyResetDate).toBe(localDateKey(DAY2));
  });

  it('rolls the day over automatically when a tick crosses midnight (16.4)', () => {
    let s = tickReadingTime(freshSession(15, DAY1), { deltaMinutes: 15, now: DAY1 });
    expect(s.arc).toBe(1);
    // A tick on the next local day resets first, then accumulates the delta.
    s = tickReadingTime(s, { deltaMinutes: 3, now: DAY2 });
    expect(s.dailyResetDate).toBe(localDateKey(DAY2));
    expect(s.accumulatedMinutes).toBe(3);
    expect(s.arc).toBeCloseTo(3 / 15, 10);
  });

  it('carries daily progress forward when re-opening the feed the same day', () => {
    const first = tickReadingTime(freshSession(30, DAY1), { deltaMinutes: 12, now: DAY1 });
    const reopened = startSession({ dailyGoalMinutes: 30, now: DAY1 + 5_000, previous: first });
    expect(reopened.viewedCount).toBe(0);
    expect(reopened.accumulatedMinutes).toBe(12);
    expect(reopened.arc).toBeCloseTo(12 / 30, 10);
  });

  it('starts a new day empty when re-opening the feed after midnight', () => {
    const first = tickReadingTime(freshSession(30, DAY1), { deltaMinutes: 12, now: DAY1 });
    const reopened = startSession({ dailyGoalMinutes: 30, now: DAY2, previous: first });
    expect(reopened.accumulatedMinutes).toBe(0);
    expect(reopened.arc).toBe(0);
    expect(reopened.dailyResetDate).toBe(localDateKey(DAY2));
  });

  it('ignores negative reading deltas', () => {
    const s = tickReadingTime(freshSession(15), { deltaMinutes: -5, now: DAY1 });
    expect(s.accumulatedMinutes).toBe(0);
    expect(s.arc).toBe(0);
  });
});

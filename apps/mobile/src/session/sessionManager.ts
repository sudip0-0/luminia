// Session_Manager (Mobile_App) — anti-doomscroll core logic.
//
// Mirrors the "Session_Manager (Mobile_App)" section of the design document.
// The behaviours described there (startSession, onCardEntered, keepGoing,
// endSession, tickReadingTime, onLocalMidnight) are implemented here as PURE
// state-transition functions: each takes the current SessionState plus an
// input and returns the next SessionState. There are no timers, no I/O, and no
// React, so the soft-feed-end and daily-goal-arc logic can be exhaustively
// unit- and property-tested without a UI.
//
// Covers two requirements:
//   - Soft feed end (Requirement 15): a per-session viewed-card counter that
//     surfaces a session-end screen at 30 cards, prevents further loading, and
//     resets on "Keep going".
//   - Daily-goal arc (Requirement 16): a capped progress ratio
//     `min(accumulatedMinutes / dailyGoal, 1.0)` updated at most once per 60s,
//     that stays full at/above the goal without wrapping and resets at local
//     midnight.
//
// The four persisted fields (viewedCount, accumulatedReadingMinutes,
// lastArcUpdateAt, dailyResetDate) match the "Session state (AsyncStorage)"
// entry in the design's data-model section.

/** The number of viewed cards that triggers the soft feed end (Requirement 15.2). */
export const SESSION_CARD_LIMIT = 30;

/**
 * Minimum spacing between progress-arc recomputations, in milliseconds
 * (Requirement 16.1: "at most once every 60 seconds").
 */
export const ARC_UPDATE_INTERVAL_MS = 60_000;

/**
 * The complete client-side session state. It folds together the per-session
 * soft-feed-end counter (Requirement 15) and the per-day daily-goal arc
 * (Requirement 16), exactly as persisted to AsyncStorage by the Mobile_App.
 *
 * All fields are readonly: transitions return a new object rather than
 * mutating in place, keeping every function a pure value-to-value mapping.
 */
export interface SessionState {
  /** Cards that have entered the viewport during the current feed session. */
  readonly viewedCount: number;
  /** Whether the soft session-end screen is currently presented. */
  readonly sessionEndPresented: boolean;
  /** The user's Daily_Goal in minutes (5–120); the arc denominator. */
  readonly dailyGoalMinutes: number;
  /** Reading minutes accumulated for the current local day. */
  readonly accumulatedMinutes: number;
  /** Progress-arc fill in [0, 1] = min(accumulatedMinutes / dailyGoal, 1). */
  readonly arc: number;
  /** Epoch ms of the last arc recomputation, or null if never computed today. */
  readonly lastArcUpdateAt: number | null;
  /** Local calendar day (YYYY-MM-DD) the daily fields belong to. */
  readonly dailyResetDate: string;
}

/** Daily-arc fields that carry across feed sessions within the same local day. */
interface DailyProgress {
  readonly accumulatedMinutes: number;
  readonly arc: number;
  readonly lastArcUpdateAt: number | null;
  readonly dailyResetDate: string;
}

/** Input for {@link startSession}. */
export interface StartSessionInput {
  /** The user's Daily_Goal in minutes; used as the arc denominator. */
  readonly dailyGoalMinutes: number;
  /** Current wall-clock time as epoch milliseconds. */
  readonly now: number;
  /**
   * The previously persisted state, if any. Its daily progress is carried
   * forward when it belongs to the same local day; otherwise the day rolls
   * over to a fresh, empty arc.
   */
  readonly previous?: SessionState | null;
}

/** Input for {@link tickReadingTime}. */
export interface TickReadingTimeInput {
  /** Reading minutes elapsed since the previous tick (negative values ignored). */
  readonly deltaMinutes: number;
  /** Current wall-clock time as epoch milliseconds. */
  readonly now: number;
}

/**
 * Local calendar-day key (YYYY-MM-DD) for an epoch timestamp, in the device's
 * local timezone. Used to detect the 00:00 daily boundary (Requirement 16.4).
 */
export function localDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Capped progress ratio min(accumulated / goal, 1), guarded for goal <= 0. */
function computeArc(accumulatedMinutes: number, dailyGoalMinutes: number): number {
  if (dailyGoalMinutes <= 0) {
    return accumulatedMinutes > 0 ? 1 : 0;
  }
  return Math.min(accumulatedMinutes / dailyGoalMinutes, 1);
}

/**
 * Begin a new feed session (Requirement 15.1): set the viewed-card count to 0
 * and dismiss any session-end screen. Daily reading progress is preserved when
 * the previous state belongs to the current local day, so the daily-goal arc
 * does not reset on every feed open — only at local midnight.
 */
export function startSession(input: StartSessionInput): SessionState {
  const { dailyGoalMinutes, now, previous } = input;
  const today = localDateKey(now);

  let daily: DailyProgress;
  if (previous != null && previous.dailyResetDate === today) {
    // Same local day: carry accumulated minutes forward and re-derive the arc
    // against the (possibly updated) Daily_Goal.
    daily = {
      accumulatedMinutes: previous.accumulatedMinutes,
      arc: computeArc(previous.accumulatedMinutes, dailyGoalMinutes),
      lastArcUpdateAt: previous.lastArcUpdateAt,
      dailyResetDate: today,
    };
  } else {
    // First session ever or a new local day: start the arc empty.
    daily = {
      accumulatedMinutes: 0,
      arc: 0,
      lastArcUpdateAt: null,
      dailyResetDate: today,
    };
  }

  return {
    viewedCount: 0,
    sessionEndPresented: false,
    dailyGoalMinutes,
    ...daily,
  };
}

/**
 * Record that an Article card entered the viewport (Requirement 15.2). The
 * viewed-card count is incremented; when it reaches {@link SESSION_CARD_LIMIT}
 * the session-end screen is flagged for presentation. While that screen is
 * presented the transition is a no-op, so the count never climbs past the
 * limit and further cards cannot register (Requirement 15.3).
 */
export function onCardEntered(state: SessionState): SessionState {
  if (state.sessionEndPresented) {
    return state;
  }
  const viewedCount = state.viewedCount + 1;
  return {
    ...state,
    viewedCount,
    sessionEndPresented: viewedCount >= SESSION_CARD_LIMIT,
  };
}

/**
 * Handle the "Keep going" control (Requirement 15.4): dismiss the session-end
 * screen and reset the viewed-card count to 0 so loading can resume. Daily
 * reading progress is untouched.
 */
export function keepGoing(state: SessionState): SessionState {
  return {
    ...state,
    viewedCount: 0,
    sessionEndPresented: false,
  };
}

/**
 * End the current feed session on feed exit (Requirement 15.5): clear the
 * per-session counter and dismiss any session-end screen. Daily reading
 * progress is preserved for the rest of the local day.
 */
export function endSession(state: SessionState): SessionState {
  return {
    ...state,
    viewedCount: 0,
    sessionEndPresented: false,
  };
}

/**
 * Accumulate reading time and update the daily-goal arc (Requirement 16.1).
 * Reading minutes are always added, but the arc fill is recomputed at most
 * once every {@link ARC_UPDATE_INTERVAL_MS} (60s). If the tick crosses a local
 * midnight boundary the daily fields are reset first (Requirement 16.4) and the
 * arc is then recomputed for the new day. The arc is capped at 1.0 and never
 * wraps, so it stays full while at/above the goal (Requirements 16.2, 16.5).
 */
export function tickReadingTime(state: SessionState, input: TickReadingTimeInput): SessionState {
  const { now } = input;
  const delta = input.deltaMinutes > 0 ? input.deltaMinutes : 0;

  // Reset first if we have crossed into a new local day.
  const base = localDateKey(now) === state.dailyResetDate ? state : onLocalMidnight(state, now);

  const accumulatedMinutes = base.accumulatedMinutes + delta;
  const elapsedSinceArc =
    base.lastArcUpdateAt == null ? Infinity : now - base.lastArcUpdateAt;

  if (elapsedSinceArc >= ARC_UPDATE_INTERVAL_MS) {
    return {
      ...base,
      accumulatedMinutes,
      arc: computeArc(accumulatedMinutes, base.dailyGoalMinutes),
      lastArcUpdateAt: now,
    };
  }

  // Within the throttle window: accumulate time but leave the visible arc as-is.
  return {
    ...base,
    accumulatedMinutes,
  };
}

/**
 * Reset accumulated reading time and clear the progress arc at local midnight
 * (Requirement 16.4). The per-session soft-feed-end fields are left untouched.
 */
export function onLocalMidnight(state: SessionState, now: number): SessionState {
  return {
    ...state,
    accumulatedMinutes: 0,
    arc: 0,
    lastArcUpdateAt: null,
    dailyResetDate: localDateKey(now),
  };
}

/**
 * Whether additional feed cards may load. Loading is blocked precisely while
 * the session-end screen is presented (Requirement 15.3).
 */
export function canLoadMore(state: SessionState): boolean {
  return !state.sessionEndPresented;
}

/**
 * Whether the Daily_Goal has been met for the current day (Requirement 16.2),
 * which the UI surfaces as the "achieved" indication. This never restricts
 * reading (Requirement 16.3).
 */
export function isDailyGoalAchieved(state: SessionState): boolean {
  return state.accumulatedMinutes >= state.dailyGoalMinutes;
}

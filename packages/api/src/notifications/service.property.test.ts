// Feature: lumina, Property 36: Notification delivery respects default-off, suppression, and the 24-hour rate limit
//
// Property-based coverage for the Notification_Service hygiene policy
// (Requirement 18). Property 36 (design.md): *For any* timeline of send
// attempts, no push is delivered while notifications are disabled (the default
// at account creation), and while enabled at most one push is delivered within
// any rolling 24-hour period.
//
// Three sub-properties are exercised, each across a generated timeline of
// `sendDaily` calls at varied timestamps and a minimum of 100 iterations:
//
//   (1) default-off / disabled — a disabled OR unknown user (default-off) never
//       causes the push transport to be invoked, and every attempt returns
//       `suppressed-disabled`, for any sequence of timestamps (Reqs 18.1, 18.4).
//   (2) rolling 24-hour rate limit — while enabled, the timestamps of the pushes
//       actually delivered by the implementation are strictly increasing and
//       always at least NOTIFICATION_WINDOW_MS apart, so no rolling 24-hour
//       window ever contains more than one delivery. A model that tracks the
//       last-sent time independently cross-checks every sent/suppressed outcome
//       (Requirement 18.2).
//   (3) fixed copy — every push the implementation actually delivers carries
//       exactly PUSH_COPY to the intended user (Requirement 18.2 hygiene; the
//       fixed message backs the single allowed daily push).
//
// Every external concern (push-enabled state, the rolling-window timestamp, and
// the push transport) is supplied via in-memory fakes of the narrow injected
// interfaces, so no live DB, Redis, or push provider is required. The
// implementation is observed only through its public API and recorded side
// effects; no implementation files are modified.
//
// Validates: Requirements 18.1, 18.2, 18.4

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PUSH_COPY,
  NOTIFICATION_WINDOW_MS,
  sendDaily,
  type NotificationPreferenceStore,
  type NotificationRateLimitStore,
  type PushSender,
} from './service.js';

const RUNS = { numRuns: 200 } as const;

// --- In-memory fakes for the injected interfaces ---------------------------

/** In-memory push-enabled preference store backed by a Map. */
class FakePreferenceStore implements NotificationPreferenceStore {
  private readonly enabled = new Map<string, boolean>();
  private readonly known = new Set<string>();

  /** Mark a user as existing with an explicit push-enabled state. */
  seed(userId: string, value: boolean): void {
    this.known.add(userId);
    this.enabled.set(userId, value);
  }

  async getPushEnabled(userId: string): Promise<boolean | null> {
    if (!this.known.has(userId)) return null; // unknown user => default-off
    return this.enabled.get(userId) ?? false; // missing entry => disabled default
  }

  async setPushEnabled(userId: string, value: boolean): Promise<boolean | null> {
    if (!this.known.has(userId)) return null;
    this.enabled.set(userId, value);
    return value;
  }
}

/** In-memory rolling-window store recording the last-notification timestamp. */
class FakeRateLimitStore implements NotificationRateLimitStore {
  private readonly timestamps = new Map<string, number>();

  async getLastNotificationAt(userId: string): Promise<number | null> {
    return this.timestamps.get(userId) ?? null;
  }

  async setLastNotificationAt(userId: string, timestampMs: number): Promise<void> {
    this.timestamps.set(userId, timestampMs);
  }
}

/** Recording push transport that captures every delivery in order. */
class FakePushSender implements PushSender {
  readonly sent: Array<{ userId: string; message: string }> = [];
  async send(userId: string, message: string): Promise<void> {
    this.sent.push({ userId, message });
  }
}

// --- Generators ------------------------------------------------------------

const USER_ID = 'user-1';

// Timestamps span several rolling windows at sub-window granularity, so a
// timeline mixes "within the window" (rate-limited) and "past the window"
// (sent) attempts. A bounded range keeps overflow/rate-limiting frequent.
const timestamp = fc.integer({ min: 0, max: 8 * NOTIFICATION_WINDOW_MS });

/**
 * A timeline of send-attempt timestamps. `sorted` optionally yields a
 * monotonic-non-decreasing timeline (the realistic scheduled-job case); the
 * unsorted case exercises arbitrary, out-of-order clocks.
 */
const timeline: fc.Arbitrary<{ times: number[]; sorted: boolean }> = fc
  .record({
    times: fc.array(timestamp, { maxLength: 30 }),
    sorted: fc.boolean(),
  })
  .map(({ times, sorted }) => ({
    times: sorted ? [...times].sort((a, b) => a - b) : times,
    sorted,
  }));

describe('Property 36 - notification hygiene: default-off, suppression, rolling 24h limit', () => {
  it('(1) disabled or unknown users never receive a push, for any timeline (Reqs 18.1, 18.4)', async () => {
    await fc.assert(
      fc.asyncProperty(
        timeline,
        // false => known but explicitly disabled; null => unknown user (default-off).
        fc.option(fc.constant(false), { nil: null }),
        async ({ times }, disabledState) => {
          const preferences = new FakePreferenceStore();
          if (disabledState === false) preferences.seed(USER_ID, false);
          // disabledState === null: leave user unknown (account-creation default).
          const rateLimit = new FakeRateLimitStore();
          const push = new FakePushSender();
          const deps = { preferences, rateLimit, push };

          for (const nowMs of times) {
            const result = await sendDaily(deps, USER_ID, nowMs);
            expect(result.status).toBe('suppressed-disabled');
          }

          // The push transport is NEVER invoked while disabled / default-off.
          expect(push.sent).toHaveLength(0);
        },
      ),
      RUNS,
    );
  });

  it('(2) enabled: deliveries are >= NOTIFICATION_WINDOW_MS apart, so any rolling 24h window holds at most one (Req 18.2)', async () => {
    await fc.assert(
      fc.asyncProperty(timeline, async ({ times }) => {
        const preferences = new FakePreferenceStore();
        preferences.seed(USER_ID, true);
        const rateLimit = new FakeRateLimitStore();
        const push = new FakePushSender();
        const deps = { preferences, rateLimit, push };

        // Independent model of the last-sent time to cross-check each outcome.
        let modelLastSent: number | null = null;
        // Timestamps of pushes actually delivered, derived from real side effects.
        const actualSentTimes: number[] = [];

        for (const nowMs of times) {
          const before = push.sent.length;
          const result = await sendDaily(deps, USER_ID, nowMs);
          const deliveredNow = push.sent.length > before;
          if (deliveredNow) actualSentTimes.push(nowMs);

          if (modelLastSent === null || nowMs - modelLastSent >= NOTIFICATION_WINDOW_MS) {
            // Eligible: the model expects a real delivery this attempt.
            expect(result.status).toBe('sent');
            expect(deliveredNow).toBe(true);
            modelLastSent = nowMs;
          } else {
            // Within the rolling window: suppressed, no new delivery.
            expect(result.status).toBe('suppressed-rate-limited');
            expect(deliveredNow).toBe(false);
          }
        }

        // Core rolling-window invariant, observed from the implementation's own
        // deliveries: successive sends are strictly increasing in time and at
        // least one full 24-hour window apart. This is equivalent to "no rolling
        // 24-hour window ever contains more than one delivery".
        for (let i = 1; i < actualSentTimes.length; i++) {
          const gap = actualSentTimes[i]! - actualSentTimes[i - 1]!;
          expect(gap).toBeGreaterThanOrEqual(NOTIFICATION_WINDOW_MS);
        }

        // The model and the implementation agree on the total number of sends.
        expect(push.sent.length).toBe(actualSentTimes.length);
      }),
      RUNS,
    );
  });

  it('(3) enabled: every delivered push carries exactly PUSH_COPY to the intended user (Req 18.2)', async () => {
    await fc.assert(
      fc.asyncProperty(timeline, async ({ times }) => {
        const preferences = new FakePreferenceStore();
        preferences.seed(USER_ID, true);
        const rateLimit = new FakeRateLimitStore();
        const push = new FakePushSender();
        const deps = { preferences, rateLimit, push };

        for (const nowMs of times) {
          const result = await sendDaily(deps, USER_ID, nowMs);
          if (result.status === 'sent') {
            expect(result.sentAt).toBe(nowMs);
          }
        }

        // Every actual delivery uses the fixed copy and targets the right user.
        for (const delivery of push.sent) {
          expect(delivery.message).toBe(PUSH_COPY);
          expect(delivery.userId).toBe(USER_ID);
        }
      }),
      RUNS,
    );
  });
});

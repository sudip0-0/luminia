// Notification_Service — push hygiene (Requirement 18).
//
// Implements the design's Notification_Service:
//   - disabled by default at account creation (Requirement 18.1)
//   - at most one push per rolling 24h when enabled (Requirement 18.2)
//   - the fixed copy "Your curiosity feed has new picks." (Requirement 18.3)
//   - never sends while disabled (Requirement 18.4)
//   - exposes the preferences toggle (PATCH /notifications/preferences)
//
// Every external concern (the user's enabled state, the rolling-window Redis
// timestamp, and the push transport) is injected behind a narrow interface, so
// the service is fully unit-testable without a live database, Redis, or push
// provider. The 24-hour window mirrors the Redis last-notification key's TTL
// (`notif:last:{userId}`); the window constant is reused from the Redis module
// rather than redefined here (Requirement 18.2).

import { NOTIFICATION_TTL_SECONDS } from '../redis/index.js';

/**
 * The fixed daily-notification copy delivered to every user (Requirement 18.3).
 * Exported so callers, tests, and any future localization layer share one
 * source of truth rather than duplicating the string literal.
 */
export const PUSH_COPY = 'Your curiosity feed has new picks.';

/**
 * The rolling rate-limit window in milliseconds (Requirement 18.2): at most one
 * push per 24 hours. Derived from the Redis last-notification key's TTL so the
 * in-memory comparison and the Redis key expiry can never drift apart.
 */
export const NOTIFICATION_WINDOW_MS = NOTIFICATION_TTL_SECONDS * 1000;

/**
 * Narrow Redis surface for the rolling 24-hour window: read and record the
 * user's last push timestamp (epoch ms). The repository-layer `RedisKeyStore`
 * satisfies this structurally via its `getLastNotificationAt` /
 * `setLastNotificationAt` accessors (key `notif:last:{userId}`, 24h TTL).
 */
export interface NotificationRateLimitStore {
  /** The user's last push timestamp (epoch ms), or null when none within 24h. */
  getLastNotificationAt(userId: string): Promise<number | null>;
  /** Record the user's last push timestamp (epoch ms) with the 24h TTL. */
  setLastNotificationAt(
    userId: string,
    timestampMs: number,
    ttlSeconds?: number,
  ): Promise<void>;
}

/**
 * The push transport that performs the actual delivery. Kept abstract so the
 * service is decoupled from the concrete provider (APNs/FCM/Expo). Production
 * wiring supplies a real sender; tests supply a recording fake.
 */
export interface PushSender {
  /** Deliver `message` to the user's registered push tokens. */
  send(userId: string, message: string): Promise<void>;
}

/**
 * Read/write the user's `push_enabled` preference. Backed in production by the
 * users repository (the `user.push_enabled` column, which defaults `false`);
 * unit tests supply an in-memory fake. A `null` return means the user does not
 * exist.
 */
export interface NotificationPreferenceStore {
  /**
   * The user's current push-enabled state, or `null` when the user does not
   * exist. A user is treated as disabled by default (Requirement 18.1).
   */
  getPushEnabled(userId: string): Promise<boolean | null>;
  /**
   * Persist the user's push-enabled state, returning the persisted value, or
   * `null` when the user does not exist.
   */
  setPushEnabled(userId: string, enabled: boolean): Promise<boolean | null>;
}

/** Dependencies for {@link sendDaily}. */
export interface SendDailyDeps {
  /** Reads the user's push-enabled state (Requirements 18.1, 18.4). */
  preferences: Pick<NotificationPreferenceStore, 'getPushEnabled'>;
  /** The rolling 24-hour last-notification window (Requirement 18.2). */
  rateLimit: NotificationRateLimitStore;
  /** Performs the actual push delivery (Requirement 18.3). */
  push: PushSender;
}

/** Dependencies for {@link setPreferences}. */
export interface SetPreferencesDeps {
  /** Persists the user's push-enabled toggle. */
  preferences: Pick<NotificationPreferenceStore, 'setPushEnabled'>;
}

/**
 * The discriminated outcome of a {@link sendDaily} attempt. Suppression is an
 * expected hygiene outcome, not an error: the service distinguishes a real send
 * from each suppression reason so callers can observe behaviour without parsing
 * error envelopes.
 */
export type SendDailyResult =
  /** A push was delivered; `sentAt` is the recorded timestamp (epoch ms). */
  | { status: 'sent'; sentAt: number }
  /** Suppressed because the user has push notifications disabled (18.1, 18.4). */
  | { status: 'suppressed-disabled' }
  /**
   * Suppressed because a push was already delivered within the rolling 24-hour
   * window (Requirement 18.2). `lastSentAt` is the prior send; `nextEligibleAt`
   * is when the next push becomes allowed.
   */
  | {
      status: 'suppressed-rate-limited';
      lastSentAt: number;
      nextEligibleAt: number;
    };

/** The discriminated outcome of persisting the preferences toggle. */
export type SetPreferencesResult =
  /** The toggle was persisted; `enabled` is the stored state. */
  | { status: 'updated'; enabled: boolean }
  /** No such user exists; nothing was persisted. */
  | { status: 'not-found' };

/**
 * Attempt to deliver the daily push for a user at `nowMs` (epoch ms), enforcing
 * the full notification-hygiene policy (Requirement 18):
 *
 *  1. Never send while disabled — a disabled or unknown user (default-off)
 *     yields `suppressed-disabled` and the push transport is never invoked
 *     (Requirements 18.1, 18.4).
 *  2. At most one push per rolling 24 hours — if a push was recorded strictly
 *     less than 24 hours before `nowMs`, the attempt yields
 *     `suppressed-rate-limited`; a prior send exactly 24 hours ago (or older)
 *     no longer falls within the window and a new push is allowed
 *     (Requirement 18.2).
 *  3. Otherwise deliver the fixed copy {@link PUSH_COPY} (Requirement 18.3) and
 *     record `nowMs` as the new last-notification timestamp.
 *
 * The timestamp is recorded only after a successful send, so a failed delivery
 * (the transport throwing) does not consume the user's daily allowance.
 */
export async function sendDaily(
  deps: SendDailyDeps,
  userId: string,
  nowMs: number,
): Promise<SendDailyResult> {
  // (18.1, 18.4) Default-off: a disabled OR unknown user never receives a push.
  const enabled = await deps.preferences.getPushEnabled(userId);
  if (enabled !== true) {
    return { status: 'suppressed-disabled' };
  }

  // (18.2) Rolling 24-hour rate limit.
  const lastSentAt = await deps.rateLimit.getLastNotificationAt(userId);
  if (lastSentAt !== null && nowMs - lastSentAt < NOTIFICATION_WINDOW_MS) {
    return {
      status: 'suppressed-rate-limited',
      lastSentAt,
      nextEligibleAt: lastSentAt + NOTIFICATION_WINDOW_MS,
    };
  }

  // (18.3) Deliver the fixed copy, then record the send for the next window.
  await deps.push.send(userId, PUSH_COPY);
  await deps.rateLimit.setLastNotificationAt(userId, nowMs);
  return { status: 'sent', sentAt: nowMs };
}

/**
 * Persist a user's push-notification preference toggle (the
 * `PATCH /notifications/preferences` endpoint). Returns `updated` with the
 * stored state, or `not-found` when the user does not exist. The
 * account-creation default of disabled (Requirement 18.1) is enforced by the
 * `user.push_enabled` column default, not by this setter.
 */
export async function setPreferences(
  deps: SetPreferencesDeps,
  userId: string,
  enabled: boolean,
): Promise<SetPreferencesResult> {
  const persisted = await deps.preferences.setPushEnabled(userId, enabled);
  if (persisted === null) {
    return { status: 'not-found' };
  }
  return { status: 'updated', enabled: persisted };
}

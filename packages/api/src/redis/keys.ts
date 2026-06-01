// Redis key builders and TTL constants.
//
// Mirrors the "Redis Keys" table in the design document. Redis holds only
// ephemeral coordination state for the stateless API tier: the revoked
// access-token denylist, the failed-login counter, the account-lockout flag,
// the per-feed-version "already returned" set, and the last-notification
// timestamp (Requirements 2.5, 2.6, 2.7, 8.2, 18.2).
//
// Every function in this module is PURE: given the same component it always
// returns the same key string and performs no I/O. This makes the key shapes
// exhaustively unit-testable without a live Redis connection.

/**
 * Default TTL for a denylisted access-token `jti`.
 *
 * The design specifies the denylist TTL as the "remaining access lifetime".
 * Access tokens live at most 15 minutes (Requirement 2.1), so this is the
 * upper bound used when a precise remaining lifetime is not supplied.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Sliding window for the failed-login counter (Requirement 2.7): 5 failures
 * within 15 minutes trigger a lockout.
 */
export const LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;

/** Account-lockout duration (Requirement 2.7): locked for 15 minutes. */
export const LOCKOUT_TTL_SECONDS = 15 * 60;

/**
 * TTL for a feed version's "already returned" article-id set (Requirement 8.2).
 *
 * The design labels this the "feed session TTL". The requirements do not fix an
 * exact duration, so this is a sensible default long enough to cover a single
 * reading session; callers may override it per call.
 */
export const FEED_VERSION_TTL_SECONDS = 60 * 60;

/**
 * Rolling window for the last-notification timestamp (Requirement 18.2): at
 * most one push per 24 hours.
 */
export const NOTIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Key for a revoked (denylisted) access token, keyed by its unique `jti`.
 * Format: `denylist:jti:{jti}` (Requirements 2.5, 2.6).
 */
export function denylistKey(jti: string): string {
  return `denylist:jti:${jti}`;
}

/**
 * Key for a user's failed-login counter.
 * Format: `login:fail:{userId}` (Requirement 2.7).
 */
export function loginFailKey(userId: string): string {
  return `login:fail:${userId}`;
}

/**
 * Key for a user's account-lockout flag.
 * Format: `lockout:{userId}` (Requirement 2.7).
 */
export function lockoutKey(userId: string): string {
  return `lockout:${userId}`;
}

/**
 * Key for the set of article ids already returned within a feed version, used
 * so cursor pages never repeat an article.
 * Format: `feedver:{feedVersion}:returned` (Requirement 8.2).
 */
export function feedVersionReturnedKey(feedVersion: string): string {
  return `feedver:${feedVersion}:returned`;
}

/**
 * Key for a user's last-notification timestamp.
 * Format: `notif:last:{userId}` (Requirement 18.2).
 */
export function notificationLastKey(userId: string): string {
  return `notif:last:${userId}`;
}

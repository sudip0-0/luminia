// Auth_Service — login, refresh, logout, and account lockout (Requirement 2).
//
// Pure orchestration over the repository layer, the Redis coordination store,
// the bcrypt password verifier, and the token helpers — no Fastify, so every
// branch is unit-testable with a FakeQueryable and an in-memory fake Redis:
//
//   login(deps, { email, password })
//     - on valid credentials, issue a 15-minute access token and a 30-day
//       refresh token (2.1) and clear the failed-login counter;
//     - on ANY failure — unknown email, wrong password, or an account with no
//       password (OAuth-only) — return the SAME generic auth error so the
//       response never reveals whether the email or the password was wrong
//       (2.2);
//     - track failed attempts in the Redis sliding-window counter; once the
//       count reaches 5 within the 15-minute window, lock the account for 15
//       minutes (2.7);
//     - if the account is currently locked, reject with the generic error even
//       when the supplied credentials are valid (2.7).
//
//   refresh(deps, { refreshToken })
//     - with a valid, non-expired, non-revoked refresh token, issue a fresh
//       15-minute access token (2.3);
//     - on an expired, malformed, revoked, or unknown token, return the generic
//       auth error (2.4).
//
//   logout(deps, { accessTokenClaims, refreshToken? })
//     - denylist the access-token `jti` for its remaining lifetime AND revoke
//       its associated refresh-token row so any subsequent use of either token
//       is rejected (2.5).
//
// login/refresh return a discriminated result: `{ ok: true, … }` on success or
// `{ ok: false, error }` carrying the uniform generic auth error envelope.

import {
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
} from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import { findUserByEmail } from '../repositories/users.repository.js';
import {
  findRefreshTokenByHash,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
} from '../repositories/refresh-tokens.repository.js';
import { hashRefreshToken } from './hash.js';
import { verifyPassword } from './passwords.js';
import type { AuthSession } from './register.js';
import {
  issueAccessToken,
  issueRefreshToken,
  revokeAccessToken,
  type AccessTokenClaims,
  type AccessTokenDenylist,
  type TokenOptions,
} from './tokens.js';

/**
 * Number of failed logins within the sliding window that triggers a lockout
 * (Requirement 2.7): the 5th consecutive failure locks the account.
 */
export const LOCKOUT_THRESHOLD = 5;

/**
 * A valid bcrypt digest of a fixed placeholder secret, compared against when no
 * account (or no password) is found. Running a real bcrypt comparison on the
 * unknown-email path keeps login latency roughly constant whether or not the
 * email exists, so response timing does not leak account existence (a timing
 * side-channel companion to the generic error, Requirement 2.2).
 */
const TIMING_EQUALIZER_HASH =
  '$2b$12$98BmbJK4UI4u9pqnO7ZEpuwqoOtjCPceGTzZ3OEj52c/lyCuqWTCe';

/** The narrow Redis surface {@link login} needs (lockout + fail counter). */
export interface LoginLockoutStore {
  /** Whether the account is currently within its lockout window. */
  isAccountLocked(userId: string): Promise<boolean>;
  /** Increment the sliding-window failed-login counter; returns the new count. */
  incrementFailedLogins(userId: string): Promise<number>;
  /** Lock the account for the lockout window (default 15 minutes). */
  lockAccount(userId: string): Promise<void>;
  /** Clear the failed-login counter (after a successful login). */
  clearFailedLogins(userId: string): Promise<void>;
}

/** Dependencies for {@link login}. */
export interface LoginDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
  /** Redis-backed lockout + failed-login counter (e.g. a {@link RedisKeyStore}). */
  redis: LoginLockoutStore;
  /** Token issuance options (clock + signing secret); injectable for tests. */
  tokenOptions?: TokenOptions;
}

/** Input for {@link login}. */
export interface LoginInput {
  email: string;
  password: string;
}

/** Discriminated result of {@link login}. */
export type LoginResult =
  | { ok: true; session: AuthSession }
  | { ok: false; error: ApiErrorEnvelope };

/** Dependencies for {@link refresh}. */
export interface RefreshDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
  /** Token issuance options (clock + signing secret); injectable for tests. */
  tokenOptions?: TokenOptions;
}

/** Input for {@link refresh}. */
export interface RefreshInput {
  /** The RAW refresh token presented by the client. */
  refreshToken: string;
}

/** Discriminated result of {@link refresh}. */
export type RefreshResult =
  | { ok: true; accessToken: string; accessTokenExpiresAt: number }
  | { ok: false; error: ApiErrorEnvelope };

/** Dependencies for {@link logout}. */
export interface LogoutDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
  /** Redis-backed access-token `jti` denylist (e.g. a {@link RedisKeyStore}). */
  redis: Pick<AccessTokenDenylist, 'denyAccessToken'>;
  /** Clock injection (epoch milliseconds); defaults to {@link Date.now}. */
  now?: () => number;
}

/** Input for {@link logout}. */
export interface LogoutInput {
  /** The verified claims of the access token being invalidated. */
  accessTokenClaims: Pick<AccessTokenClaims, 'userId' | 'jti' | 'exp'>;
  /**
   * The RAW refresh token to revoke. When omitted, every active refresh token
   * for the user is revoked so the session's refresh token cannot be reused.
   */
  refreshToken?: string;
}

/**
 * The single generic authentication error returned by every login and refresh
 * failure. Using one envelope for all failure classes makes failures
 * indistinguishable — nothing reveals whether the email existed, the password
 * was wrong, or the refresh token was expired/revoked (Requirements 2.2, 2.4).
 */
export function genericAuthError(): ApiErrorEnvelope {
  return makeError(ERROR_CODES.AUTH_FAILED, 'Authentication failed.');
}

/** Build a `{ ok: false, error }` result carrying the generic auth error. */
function authFailure(): { ok: false; error: ApiErrorEnvelope } {
  return { ok: false, error: genericAuthError() };
}

/** Issue an access + refresh token pair for a user (Requirement 2.1). */
async function issueSession(
  db: Queryable,
  userId: string,
  tokenOptions: TokenOptions = {},
): Promise<AuthSession> {
  const access = issueAccessToken(userId, tokenOptions);
  const refresh = await issueRefreshToken(db, userId, { now: tokenOptions.now });
  return {
    userId,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

/**
 * Authenticate an email/password login (Requirement 2). Enforces account
 * lockout, verifies the password in constant-ish time, issues a token pair on
 * success, and returns the uniform generic error on every failure.
 */
export async function login(
  deps: LoginDeps,
  input: LoginInput,
): Promise<LoginResult> {
  const { db, redis, tokenOptions } = deps;
  const { email, password } = input;

  const user = await findUserByEmail(db, email);

  // Unknown email (2.2): run a dummy bcrypt comparison to equalize timing, then
  // return the same generic error as a wrong-password failure. There is no
  // account to lock, so no counter is touched (2.7 is per existing account).
  if (!user) {
    await verifyPassword(password, TIMING_EQUALIZER_HASH);
    return authFailure();
  }

  // Locked account (2.7): reject with the generic error even when the supplied
  // credentials are valid, and without consuming another failure attempt.
  if (await redis.isAccountLocked(user.id)) {
    return authFailure();
  }

  // Verify the password. An OAuth-only account (null hash) can never match a
  // password login; still run a dummy comparison so its timing matches.
  const hashToCheck = user.passwordHash ?? TIMING_EQUALIZER_HASH;
  const passwordValid =
    user.passwordHash !== null &&
    (await verifyPassword(password, hashToCheck));

  if (!passwordValid) {
    // Wrong password (2.2): record the failure and lock the account once the
    // count reaches the threshold within the sliding window (2.7).
    const failures = await redis.incrementFailedLogins(user.id);
    if (failures >= LOCKOUT_THRESHOLD) {
      await redis.lockAccount(user.id);
    }
    return authFailure();
  }

  // Valid credentials (2.1): clear the counter and issue a fresh token pair.
  await redis.clearFailedLogins(user.id);
  const session = await issueSession(db, user.id, tokenOptions);
  return { ok: true, session };
}

/**
 * Exchange a refresh token for a new 15-minute access token (Requirements 2.3,
 * 2.4). The presented token is hashed and looked up; a missing, revoked, or
 * expired row yields the generic auth error. A new refresh token is NOT issued
 * — the existing 30-day refresh token continues until logout or expiry.
 */
export async function refresh(
  deps: RefreshDeps,
  input: RefreshInput,
): Promise<RefreshResult> {
  const { db, tokenOptions } = deps;
  const { refreshToken } = input;

  // Hashing any string is safe; an unknown/malformed token simply won't match a
  // stored hash, so it falls through to the generic error (2.4).
  const tokenHash = hashRefreshToken(refreshToken);
  const record = await findRefreshTokenByHash(db, tokenHash);

  if (!record) return authFailure();
  if (record.revokedAt !== null) return authFailure();

  const nowMs = (tokenOptions?.now ?? Date.now)();
  if (new Date(record.expiresAt).getTime() <= nowMs) {
    return authFailure();
  }

  const access = issueAccessToken(record.userId, tokenOptions);
  return {
    ok: true,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
  };
}

/**
 * Invalidate a session (Requirement 2.5). Denylists the access-token `jti` for
 * its remaining lifetime and revokes the associated refresh-token row — the
 * specific token when supplied, otherwise every active refresh token for the
 * user — so any subsequent request presenting either token is rejected.
 */
export async function logout(
  deps: LogoutDeps,
  input: LogoutInput,
): Promise<void> {
  const { db, redis, now } = deps;
  const { accessTokenClaims, refreshToken } = input;

  // Denylist the access token's jti for the remainder of its lifetime.
  await revokeAccessToken(
    redis,
    { jti: accessTokenClaims.jti, exp: accessTokenClaims.exp },
    { now },
  );

  // Revoke the associated refresh token(s).
  if (refreshToken !== undefined) {
    await revokeRefreshToken(db, hashRefreshToken(refreshToken));
  } else {
    await revokeAllRefreshTokensForUser(db, accessTokenClaims.userId);
  }
}

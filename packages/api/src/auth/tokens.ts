// Auth_Service token issuance, verification, and revocation.
//
// Implements the design's Auth_Service "Tokens" subsection:
//   - `issueAccessToken(userId)`  -> a 15-minute JWT carrying a unique `jti`
//   - `issueRefreshToken(userId)` -> a 30-day opaque token, hashed at rest
//   - access-token verification    -> signature + expiry + Redis denylist check
//   - `revokeAccessToken(jti)`     -> denylist the jti for its remaining lifetime
//
// All authentication failures (missing, malformed, expired, denylisted) are
// surfaced through the uniform generic error envelope so protected routes never
// leak why a token was rejected (Requirements 2.1, 2.5, 2.6, 26.4).

import { randomUUID } from 'node:crypto';
import jwt, {
  type JwtPayload,
  type SignOptions,
} from 'jsonwebtoken';
import { ERROR_CODES, makeError, type ApiErrorEnvelope } from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import { createRefreshToken } from '../repositories/refresh-tokens.repository.js';
import type { RefreshTokenRecord } from '../repositories/types.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  getAccessTokenSecret,
} from './config.js';
import { generateRefreshToken, hashRefreshToken } from './hash.js';

/** The narrow Redis surface the token helpers need (the `jti` denylist). */
export interface AccessTokenDenylist {
  denyAccessToken(jti: string, ttlSeconds?: number): Promise<void>;
  isAccessTokenDenied(jti: string): Promise<boolean>;
}

/** Verified claims extracted from a valid access token. */
export interface AccessTokenClaims {
  /** The authenticated user's id (the JWT `sub`). */
  userId: string;
  /** The token's unique id, used for denylist revocation (the JWT `jti`). */
  jti: string;
  /** Expiry as epoch seconds (the JWT `exp`). */
  exp: number;
  /** Issued-at as epoch seconds (the JWT `iat`). */
  iat: number;
}

/** Why access-token verification failed; never surfaced to the client. */
export type AccessTokenFailureReason =
  | 'missing'
  | 'malformed'
  | 'expired'
  | 'denylisted';

/** Discriminated result of verifying an access token. */
export type AccessTokenVerification =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: AccessTokenFailureReason };

/** The result of issuing an access token. */
export interface IssuedAccessToken {
  /** The signed compact JWT to hand to the client. */
  token: string;
  /** The token's unique id (claim `jti`). */
  jti: string;
  /** Expiry as epoch seconds (claim `exp`). */
  expiresAt: number;
}

/** The result of issuing a refresh token. */
export interface IssuedRefreshToken {
  /** The RAW opaque token, returned to the caller exactly once. */
  token: string;
  /** The persisted (hashed) row; the raw token is never stored. */
  record: RefreshTokenRecord;
  /** Expiry as an ISO-8601 timestamp. */
  expiresAt: string;
}

/** Common options for token issuance/verification (overridable in tests). */
export interface TokenOptions {
  /** Signing secret; defaults to the env-configured access-token secret. */
  secret?: string;
  /** Clock injection (epoch milliseconds); defaults to {@link Date.now}. */
  now?: () => number;
}

/**
 * Issue a 15-minute access token for a user with a unique `jti`
 * (Requirements 2.1, 2.6). The `jti` is a v4 UUID so revoked tokens can be
 * denylisted individually.
 */
export function issueAccessToken(
  userId: string,
  options: TokenOptions = {},
): IssuedAccessToken {
  const secret = options.secret ?? getAccessTokenSecret();
  const nowMs = (options.now ?? Date.now)();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  const jti = randomUUID();

  const signOptions: SignOptions = {
    subject: userId,
    jwtid: jti,
  };
  // Pin iat/exp explicitly in the payload so issuance is deterministic under an
  // injected clock. jsonwebtoken honours a payload-supplied `iat` as the token
  // timestamp and leaves a payload-supplied `exp` untouched, so we avoid the
  // `expiresIn` option (which would conflict with an explicit `exp`).
  const token = jwt.sign({ iat, exp }, secret, signOptions);

  return { token, jti, expiresAt: exp };
}

/**
 * Issue a 30-day refresh token (Requirement 2.1). A high-entropy opaque token
 * is generated, its HASH is persisted via the refresh-tokens repository, and
 * the RAW token is returned to the caller — the raw value never touches the
 * database (Requirement 2.5).
 */
export async function issueRefreshToken(
  db: Queryable,
  userId: string,
  options: Pick<TokenOptions, 'now'> = {},
): Promise<IssuedRefreshToken> {
  const nowMs = (options.now ?? Date.now)();
  const expiresAtIso = new Date(
    nowMs + REFRESH_TOKEN_TTL_SECONDS * 1000,
  ).toISOString();

  const rawToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);

  const record = await createRefreshToken(db, {
    userId,
    tokenHash,
    expiresAt: expiresAtIso,
  });

  return { token: rawToken, record, expiresAt: expiresAtIso };
}

/**
 * Verify an access token: confirm the signature and expiry, extract the `jti`,
 * and reject it if the `jti` is denylisted (Requirements 2.6, 26.4). Returns a
 * discriminated result rather than throwing so callers can map every failure to
 * the same generic error.
 */
export async function verifyAccessToken(
  denylist: Pick<AccessTokenDenylist, 'isAccessTokenDenied'>,
  token: string | undefined | null,
  options: TokenOptions = {},
): Promise<AccessTokenVerification> {
  if (!token) return { ok: false, reason: 'missing' };

  const secret = options.secret ?? getAccessTokenSecret();
  const clockTimestamp = Math.floor((options.now ?? Date.now)() / 1000);

  let payload: JwtPayload;
  try {
    const decoded = jwt.verify(token, secret, { clockTimestamp });
    if (typeof decoded === 'string') {
      return { ok: false, reason: 'malformed' };
    }
    payload = decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, reason: 'expired' };
    }
    // JsonWebTokenError, NotBeforeError, and anything else => malformed/invalid.
    return { ok: false, reason: 'malformed' };
  }

  const userId = payload.sub;
  const jti = payload.jti;
  if (
    typeof userId !== 'string' ||
    typeof jti !== 'string' ||
    typeof payload.exp !== 'number' ||
    typeof payload.iat !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (await denylist.isAccessTokenDenied(jti)) {
    return { ok: false, reason: 'denylisted' };
  }

  return {
    ok: true,
    claims: { userId, jti, exp: payload.exp, iat: payload.iat },
  };
}

/**
 * Revoke an access token by denylisting its `jti` for the remainder of its
 * lifetime (used by logout). The TTL is the time until the token's own `exp`,
 * so the denylist self-heals exactly when the token would have expired anyway
 * (Requirement 2.5). Already-expired tokens are a no-op.
 */
export async function revokeAccessToken(
  denylist: Pick<AccessTokenDenylist, 'denyAccessToken'>,
  claims: Pick<AccessTokenClaims, 'jti' | 'exp'>,
  options: Pick<TokenOptions, 'now'> = {},
): Promise<void> {
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const remaining = claims.exp - nowSeconds;
  if (remaining <= 0) return;
  await denylist.denyAccessToken(claims.jti, Math.min(remaining, ACCESS_TOKEN_TTL_SECONDS));
}

/**
 * Extract a bearer token from an `Authorization` header value. Returns `null`
 * when the header is absent or not a well-formed `Bearer <token>`.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() || null : null;
}

/** The single generic authorization error returned by protected routes. */
export function authorizationError(): ApiErrorEnvelope {
  return makeError(ERROR_CODES.AUTH_FAILED, 'Authentication required.');
}

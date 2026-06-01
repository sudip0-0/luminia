// Auth_Service — registration and OAuth registration (Requirement 1).
//
// Two entry points, both pure orchestration over the repository layer, the
// shared validators, the bcrypt password hasher, and the token helpers — no
// Fastify, so every branch is unit-testable with a FakeQueryable and a fake
// OAuth verifier:
//
//   register(deps, input)
//     - validate email format/length (1.3), password length (1.4), and the
//       Daily_Goal range when provided (1.7, 1.8); validate Depth_Preference
//       when provided so an unknown value never reaches the enum column;
//     - reject a duplicate email with a CONFLICT error (1.2);
//     - default the omitted Daily_Goal to 15 and Depth_Preference to balanced
//       (1.9);
//     - hash the password (bcrypt), create the account, and issue an
//       access + refresh token pair (1.1).
//
//   registerOAuth(deps, input)
//     - accept only the google or apple provider and only an identity the
//       injected OAuthVerifier confirms; otherwise reject (1.6);
//     - reuse the account already linked to the identity, else link the
//       identity to an existing account whose email matches the provider email,
//       else create a new (password-less) account; then issue tokens (1.5).
//
// Both return a discriminated result: `{ ok: true, session }` carrying the
// issued tokens, or `{ ok: false, error }` carrying the uniform error envelope.

import {
  ERROR_CODES,
  MAX_DISPLAY_NAME_LENGTH,
  makeError,
  validateDailyGoal,
  validateDepth,
  validateEmail,
  validatePassword,
  type ApiErrorEnvelope,
  type Depth,
} from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  DEFAULT_DEPTH_PREFERENCE,
  createUser,
  findUserByEmail,
} from '../repositories/users.repository.js';
import {
  findOAuthIdentity,
  linkOAuthIdentity,
} from '../repositories/oauth-identities.repository.js';
import type { OAuthProvider } from '../repositories/types.js';
import { hashPassword } from './passwords.js';
import {
  issueAccessToken,
  issueRefreshToken,
  type TokenOptions,
} from './tokens.js';

/** The OAuth providers Lumina supports (Requirements 1.5, 1.6). */
export const SUPPORTED_OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  'google',
  'apple',
];

/** An issued access + refresh token pair plus the owning user id. */
export interface AuthSession {
  /** The authenticated user's id. */
  userId: string;
  /** Signed 15-minute access JWT. */
  accessToken: string;
  /** Access-token expiry as epoch seconds. */
  accessTokenExpiresAt: number;
  /** Raw 30-day refresh token (returned to the caller exactly once). */
  refreshToken: string;
  /** Refresh-token expiry as an ISO-8601 timestamp. */
  refreshTokenExpiresAt: string;
}

/** Discriminated result of {@link register}. */
export type RegisterResult =
  | { ok: true; session: AuthSession }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * How an OAuth registration resolved:
 *  - `created`  — a brand-new account was created and the identity linked;
 *  - `linked`   — the identity was linked to an existing email-matched account;
 *  - `existing` — the identity was already linked; the account was reused.
 */
export type OAuthRegisterOutcome = 'created' | 'linked' | 'existing';

/** Discriminated result of {@link registerOAuth}. */
export type OAuthRegisterResult =
  | { ok: true; session: AuthSession; outcome: OAuthRegisterOutcome }
  | { ok: false; error: ApiErrorEnvelope };

/** Dependencies shared by both registration flows. */
export interface RegisterDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
  /** Token issuance options (clock + signing secret); injectable for tests. */
  tokenOptions?: TokenOptions;
}

/** Input for email/password registration. */
export interface RegisterInput {
  email: string;
  password: string;
  /** Optional Daily_Goal in minutes; defaults to 15 when omitted (1.9). */
  dailyGoal?: number;
  /** Optional Depth_Preference; defaults to balanced when omitted (1.9). */
  depth?: Depth;
}

/** A provider identity confirmed by an {@link OAuthVerifier}. */
export interface VerifiedOAuthIdentity {
  /** The provider's stable user identifier. */
  providerUserId: string;
  /** The provider-supplied email used to match or create the account. */
  email: string;
  /** Optional provider display name used as the new account's display name. */
  displayName?: string | null;
}

/**
 * Verifies an opaque provider credential out-of-band (e.g. validating a Google
 * ID token or an Apple identity token). Injected so tests can fake verification
 * without contacting a provider. Returning `null` (or throwing) means the
 * identity could not be verified (Requirement 1.6).
 */
export interface OAuthVerifier {
  verify(
    provider: OAuthProvider,
    providerToken: string,
  ): Promise<VerifiedOAuthIdentity | null>;
}

/** Dependencies for {@link registerOAuth}. */
export interface RegisterOAuthDeps extends RegisterDeps {
  /** Verifies the provider credential; faked in tests. */
  verifier: OAuthVerifier;
}

/** Input for OAuth registration. */
export interface RegisterOAuthInput {
  /** Requested provider; validated against {@link SUPPORTED_OAUTH_PROVIDERS}. */
  provider: string;
  /** Opaque provider credential to verify (e.g. an ID token). */
  providerToken: string;
}

/** Build a `{ ok: false, error }` result from a uniform error envelope. */
function failure(error: ApiErrorEnvelope): { ok: false; error: ApiErrorEnvelope } {
  return { ok: false, error };
}

/** True when `err` is a PostgreSQL unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

/**
 * Derive a valid display name (1–50 chars, Requirement 26.2) for a newly
 * created account. Prefers a provider-supplied name, falls back to the email
 * local part, and finally to a generic label so the NOT NULL column is always
 * satisfied with an in-range value.
 */
function defaultDisplayName(email: string, provided?: string | null): string {
  const fromProvider = (provided ?? '').trim();
  const localPart = email.split('@')[0] ?? '';
  const candidate = (fromProvider || localPart).slice(0, MAX_DISPLAY_NAME_LENGTH);
  return candidate.length >= 1 ? candidate : 'Reader';
}

/** Issue an access + refresh token pair for a user (Requirements 1.1, 2.1). */
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
 * Register a new account from an email and password (Requirement 1). Validates
 * the inputs, enforces email uniqueness, applies the goal/depth defaults, hashes
 * the password with bcrypt, persists the account, and returns a fresh session.
 */
export async function register(
  deps: RegisterDeps,
  input: RegisterInput,
): Promise<RegisterResult> {
  const { db, tokenOptions } = deps;
  const { email, password, dailyGoal, depth } = input;

  // 1.3 — email format and length.
  if (!validateEmail(email)) {
    return failure(
      makeError(ERROR_CODES.VALIDATION_ERROR, 'A valid email address is required.', {
        field: 'email',
      }),
    );
  }

  // 1.4 — password length 8–128.
  if (!validatePassword(password)) {
    return failure(
      makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Password must be between 8 and 128 characters.',
        { field: 'password' },
      ),
    );
  }

  // 1.7, 1.8 — Daily_Goal range, only when supplied.
  if (dailyGoal !== undefined && !validateDailyGoal(dailyGoal)) {
    return failure(
      makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Daily goal must be an integer between 5 and 120 minutes.',
        { field: 'dailyGoal' },
      ),
    );
  }

  // Validate a supplied Depth_Preference so an unknown value never reaches the
  // enum column; an omitted depth is defaulted below (1.9).
  if (depth !== undefined && !validateDepth(depth)) {
    return failure(
      makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Depth preference must be one of quick, balanced, or deep.',
        { field: 'depth' },
      ),
    );
  }

  // 1.2 — reject a duplicate email up front (the unique index is the backstop).
  const existing = await findUserByEmail(db, email);
  if (existing) {
    return failure(
      makeError(
        ERROR_CODES.CONFLICT,
        'An account with this email is already registered.',
        { field: 'email' },
      ),
    );
  }

  const passwordHash = await hashPassword(password);

  // 1.9 — apply the goal/depth defaults when omitted.
  let userId: string;
  try {
    const user = await createUser(db, {
      email,
      passwordHash,
      displayName: defaultDisplayName(email),
      depthPreference: depth ?? DEFAULT_DEPTH_PREFERENCE,
      dailyGoalMinutes: dailyGoal ?? DEFAULT_DAILY_GOAL_MINUTES,
    });
    userId = user.id;
  } catch (err) {
    // A concurrent insert can still collide on the unique email index; surface
    // it as the same conflict rather than a 500 (1.2).
    if (isUniqueViolation(err)) {
      return failure(
        makeError(
          ERROR_CODES.CONFLICT,
          'An account with this email is already registered.',
          { field: 'email' },
        ),
      );
    }
    throw err;
  }

  // 1.1 — return an authenticated session.
  const session = await issueSession(db, userId, tokenOptions);
  return { ok: true, session };
}

/** The uniform "OAuth could not be completed" error (Requirement 1.6). */
function oauthError(message: string, details?: unknown): ApiErrorEnvelope {
  return makeError(ERROR_CODES.VALIDATION_ERROR, message, details);
}

/**
 * Register or sign in via an OAuth provider (Requirements 1.5, 1.6). Only
 * google/apple are accepted and only when the injected verifier confirms the
 * identity; the account is reused when already linked, linked to an
 * email-matched account, or created fresh, and a session is returned.
 */
export async function registerOAuth(
  deps: RegisterOAuthDeps,
  input: RegisterOAuthInput,
): Promise<OAuthRegisterResult> {
  const { db, verifier, tokenOptions } = deps;
  const { provider, providerToken } = input;

  // 1.6 — only the supported providers.
  if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider as OAuthProvider)) {
    return failure(
      oauthError('OAuth registration could not be completed: unsupported provider.', {
        field: 'provider',
      }),
    );
  }
  const supportedProvider = provider as OAuthProvider;

  // 1.6 — verify the identity; any failure (null, throw, or missing email)
  // means the identity could not be verified.
  let identity: VerifiedOAuthIdentity | null;
  try {
    identity = await verifier.verify(supportedProvider, providerToken);
  } catch {
    identity = null;
  }
  if (!identity || !identity.providerUserId || !validateEmail(identity.email)) {
    return failure(
      oauthError(
        'OAuth registration could not be completed: the provider identity could not be verified.',
      ),
    );
  }

  // 1.5 — reuse the account already linked to this identity.
  const linked = await findOAuthIdentity(
    db,
    supportedProvider,
    identity.providerUserId,
  );
  if (linked) {
    const session = await issueSession(db, linked.userId, tokenOptions);
    return { ok: true, session, outcome: 'existing' };
  }

  // 1.5 — link the identity to an existing account whose email matches.
  const byEmail = await findUserByEmail(db, identity.email);
  if (byEmail) {
    await linkOAuthIdentity(db, {
      userId: byEmail.id,
      provider: supportedProvider,
      providerUserId: identity.providerUserId,
      email: identity.email,
    });
    const session = await issueSession(db, byEmail.id, tokenOptions);
    return { ok: true, session, outcome: 'linked' };
  }

  // 1.5 — otherwise create a new, password-less account and link the identity.
  const user = await createUser(db, {
    email: identity.email,
    passwordHash: null,
    displayName: defaultDisplayName(identity.email, identity.displayName),
  });
  await linkOAuthIdentity(db, {
    userId: user.id,
    provider: supportedProvider,
    providerUserId: identity.providerUserId,
    email: identity.email,
  });
  const session = await issueSession(db, user.id, tokenOptions);
  return { ok: true, session, outcome: 'created' };
}

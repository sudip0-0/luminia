// Auth_Service token configuration.
//
// Centralizes the token lifetimes and the access-token signing secret so the
// issuance, verification, and revocation helpers all agree. See the design's
// Auth_Service "Tokens" subsection: access tokens live 15 minutes with a unique
// `jti`; refresh tokens live 30 days and are hashed at rest (Requirements 2.1,
// 2.5, 2.6, 26.4).

/**
 * Access-token lifetime in seconds (Requirement 2.1): 15 minutes. This also
 * bounds the maximum TTL of a denylist entry — a revoked `jti` only needs to be
 * remembered until the token would have expired on its own.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh-token lifetime in seconds (Requirement 2.1): 30 days. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Development/test default for the access-token signing secret. Production MUST
 * override this via {@link ACCESS_TOKEN_SECRET_ENV}; it exists only so tests and
 * local runs work without external configuration. It is intentionally obvious
 * so a leaked production secret of this value is trivially spotted.
 */
export const TEST_DEFAULT_ACCESS_TOKEN_SECRET =
  'lumina-test-access-token-secret-do-not-use-in-production';

/** Environment variable holding the access-token signing secret. */
export const ACCESS_TOKEN_SECRET_ENV = 'AUTH_ACCESS_TOKEN_SECRET';

/**
 * Resolve the access-token signing secret from the environment, falling back to
 * the test default when unset. Keeping this configurable (rather than hardcoded)
 * lets each environment use its own secret while tests stay hermetic.
 */
export function getAccessTokenSecret(): string {
  const fromEnv = process.env[ACCESS_TOKEN_SECRET_ENV];
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : TEST_DEFAULT_ACCESS_TOKEN_SECRET;
}

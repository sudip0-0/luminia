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
 * Minimum length for a production access-token signing secret. Shorter values
 * are rejected so a misconfigured deploy cannot silently use a weak secret.
 */
export const MIN_ACCESS_TOKEN_SECRET_LENGTH = 32;

/**
 * Development/test default for the access-token signing secret. Production MUST
 * set {@link ACCESS_TOKEN_SECRET_ENV}; the default is only allowed when
 * `NODE_ENV=test` or {@link ALLOW_TEST_SECRET_ENV} is truthy.
 */
export const TEST_DEFAULT_ACCESS_TOKEN_SECRET =
  'lumina-test-access-token-secret-do-not-use-in-production';

/** Environment variable holding the access-token signing secret. */
export const ACCESS_TOKEN_SECRET_ENV = 'AUTH_ACCESS_TOKEN_SECRET';

/**
 * When set to a truthy value (`1`, `true`, `yes`), allows falling back to
 * {@link TEST_DEFAULT_ACCESS_TOKEN_SECRET} outside of `NODE_ENV=test`.
 */
export const ALLOW_TEST_SECRET_ENV = 'AUTH_ALLOW_TEST_SECRET';

/** Whether the process is allowed to use the built-in test signing secret. */
export function allowsTestAccessTokenSecret(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === 'test') return true;
  const flag = env[ALLOW_TEST_SECRET_ENV];
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Resolve the access-token signing secret from the environment.
 *
 * Fail-closed: when the env var is unset/empty/too short and the test-secret
 * escape hatch is not enabled, this throws so a misconfigured process cannot
 * mint or verify tokens with a known default.
 */
export function getAccessTokenSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[ACCESS_TOKEN_SECRET_ENV];
  if (fromEnv && fromEnv.length >= MIN_ACCESS_TOKEN_SECRET_LENGTH) {
    return fromEnv;
  }
  if (fromEnv && fromEnv.length > 0) {
    throw new Error(
      `${ACCESS_TOKEN_SECRET_ENV} must be at least ${MIN_ACCESS_TOKEN_SECRET_LENGTH} characters.`,
    );
  }
  if (allowsTestAccessTokenSecret(env)) {
    return TEST_DEFAULT_ACCESS_TOKEN_SECRET;
  }
  throw new Error(
    `${ACCESS_TOKEN_SECRET_ENV} is required (set NODE_ENV=test or ${ALLOW_TEST_SECRET_ENV}=1 only for local/test).`,
  );
}

// Refresh-token hashing.
//
// Refresh tokens are opaque random strings handed to the client but stored ONLY
// as a hash at rest (Requirements 2.1, 2.5): the database never holds a value
// that could be replayed if the table leaked. A refresh token is a
// high-entropy random secret (not a low-entropy password), so a fast,
// deterministic SHA-256 is appropriate and lets us look the token up by its
// hash without a per-row salt. (A slow KDF like bcrypt is reserved for
// user-chosen passwords, which are brute-forceable.)

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Byte length of a freshly generated opaque refresh token before encoding. */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Generate a new opaque refresh token: 256 bits of randomness, URL-safe
 * base64. This raw value is returned to the caller exactly once and never
 * persisted.
 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/**
 * Hash a raw refresh token for storage/lookup. Deterministic so a presented
 * token can be matched against the stored hash; SHA-256 over the raw token.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two refresh-token hashes, avoiding a timing side
 * channel when verifying a presented token against a stored hash.
 */
export function refreshTokenHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

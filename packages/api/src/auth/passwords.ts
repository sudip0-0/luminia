// User-password hashing.
//
// User passwords are low-entropy, human-chosen secrets, so — unlike opaque
// refresh tokens (see ./hash.ts, which uses a fast SHA-256) — they are hashed
// with bcrypt, a deliberately slow, salted adaptive KDF. bcrypt embeds a
// per-password random salt and a cost factor in the resulting digest, so equal
// passwords produce different hashes and brute-forcing a leaked `password_hash`
// column stays expensive (Requirements 1.1, 1.4 — the stored credential never
// holds a recoverable password).
//
// `bcryptjs` is the pure-JavaScript implementation, so it needs no native build
// step and runs identically across platforms and CI.

import { compare, hash } from 'bcryptjs';

/**
 * bcrypt cost factor (work = 2^rounds). 12 is a current, sensible default:
 * meaningfully expensive for an attacker while keeping a single registration or
 * login hash in the low tens of milliseconds.
 */
export const BCRYPT_ROUNDS = 12;

/**
 * Maximum password byte length bcrypt considers. bcrypt silently truncates
 * input beyond 72 bytes; {@link validatePassword} already caps passwords at 128
 * characters, but this constant documents the underlying limit.
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

/**
 * Hash a plaintext password for storage. Each call generates a fresh random
 * salt, so the same password hashes to a different digest every time. The
 * returned string is the self-describing bcrypt digest (algorithm, cost, salt,
 * and hash) suitable for the `user.password_hash` column.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored bcrypt digest in constant time
 * (bcrypt's own comparison). Returns `false` rather than throwing on a
 * malformed digest so callers can treat every mismatch uniformly.
 */
export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await compare(password, passwordHash);
  } catch {
    return false;
  }
}

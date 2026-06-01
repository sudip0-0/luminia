// Refresh tokens repository — typed query functions over `refresh_token`.
//
// Tokens are stored HASHED at rest (Requirements 2.1, 2.5); the raw token never
// touches the database. Supports create, find-by-hash, and revoke (single and
// all-for-user, used by logout). All queries are parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapRefreshToken } from './rows.js';
import type { RefreshTokenRecord } from './types.js';

const REFRESH_COLUMNS = `
  id, user_id, token_hash, expires_at, revoked_at, created_at
`;

/** Create a refresh token row from its hash and expiry. */
export async function createRefreshToken(
  db: Queryable,
  input: { userId: string; tokenHash: string; expiresAt: string },
): Promise<RefreshTokenRecord> {
  const sql = `
    INSERT INTO refresh_token (user_id, token_hash, expires_at)
    VALUES ($1, $2, $3)
    RETURNING ${REFRESH_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [
    input.userId,
    input.tokenHash,
    input.expiresAt,
  ]);
  if (!row) throw new Error('createRefreshToken did not return a row.');
  return mapRefreshToken(row);
}

/** Find a refresh token by its stored hash. */
export async function findRefreshTokenByHash(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const sql = `SELECT ${REFRESH_COLUMNS} FROM refresh_token WHERE token_hash = $1`;
  const row = await queryMaybeOne(db, sql, [tokenHash]);
  return row ? mapRefreshToken(row) : null;
}

/**
 * Revoke a single refresh token by hash, setting `revoked_at = now()` only when
 * not already revoked. Returns the updated row, or `null` when no matching,
 * not-yet-revoked token exists.
 */
export async function revokeRefreshToken(
  db: Queryable,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const sql = `
    UPDATE refresh_token
    SET revoked_at = now()
    WHERE token_hash = $1 AND revoked_at IS NULL
    RETURNING ${REFRESH_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [tokenHash]);
  return row ? mapRefreshToken(row) : null;
}

/**
 * Revoke every active refresh token for a user (e.g. on logout-all). Returns
 * the revoked rows.
 */
export async function revokeAllRefreshTokensForUser(
  db: Queryable,
  userId: string,
): Promise<RefreshTokenRecord[]> {
  const sql = `
    UPDATE refresh_token
    SET revoked_at = now()
    WHERE user_id = $1 AND revoked_at IS NULL
    RETURNING ${REFRESH_COLUMNS}
  `;
  const rows = await queryRows(db, sql, [userId]);
  return rows.map(mapRefreshToken);
}

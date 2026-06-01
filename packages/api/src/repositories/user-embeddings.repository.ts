// User-embeddings repository — typed query functions over `user_embedding`.
//
// Holds the user's 1536-dim interest vector recomputed by the
// Preference_Model_Updater (Requirement 14.4). Absence of a row means "no
// User_Embedding", which triggers the Ranking_Engine fallback (Requirement
// 9.7). The vector is bound as the `pgvector` literal `[v0,…]`. All queries are
// parameterized.

import { type Queryable, queryMaybeOne } from './queryable.js';
import { mapUserEmbedding } from './rows.js';
import { serializeVector } from './mappers.js';
import type { UserEmbeddingRecord } from './types.js';

const USER_EMBEDDING_COLUMNS = `user_id, embedding, updated_at`;

/**
 * Get a user's embedding, or `null` when no row exists (the "no User_Embedding"
 * signal for the Ranking_Engine fallback, Requirement 9.7).
 */
export async function getUserEmbedding(
  db: Queryable,
  userId: string,
): Promise<UserEmbeddingRecord | null> {
  const sql = `SELECT ${USER_EMBEDDING_COLUMNS} FROM user_embedding WHERE user_id = $1`;
  const row = await queryMaybeOne(db, sql, [userId]);
  return row ? mapUserEmbedding(row) : null;
}

/**
 * Insert or replace a user's embedding, refreshing `updated_at`. Returns the
 * stored row.
 */
export async function upsertUserEmbedding(
  db: Queryable,
  userId: string,
  embedding: readonly number[],
): Promise<UserEmbeddingRecord> {
  const sql = `
    INSERT INTO user_embedding (user_id, embedding, updated_at)
    VALUES ($1, $2::vector, now())
    ON CONFLICT (user_id) DO UPDATE
      SET embedding = EXCLUDED.embedding,
          updated_at = now()
    RETURNING ${USER_EMBEDDING_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, serializeVector([...embedding])]);
  if (!row) throw new Error('upsertUserEmbedding did not return a row.');
  return mapUserEmbedding(row);
}

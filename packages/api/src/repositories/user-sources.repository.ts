// User-sources repository — typed query functions over `user_source`.
//
// Persists each Source's enabled/disabled state per user during onboarding
// (Requirements 3.7, 4.4) and lists it for feed assembly. All queries are
// parameterized.

import { type Queryable, queryMaybeOne, queryRows } from './queryable.js';
import { mapUserSource } from './rows.js';
import type { Source } from '@lumina/shared';
import type { UserSourceRecord } from './types.js';

const USER_SOURCE_COLUMNS = `user_id, source, enabled`;

/**
 * Set the enabled state for a single source for a user, inserting on first set
 * and updating on conflict (the (user, source) PK). Returns the resulting row.
 */
export async function setUserSourceEnabled(
  db: Queryable,
  userId: string,
  source: Source,
  enabled: boolean,
): Promise<UserSourceRecord> {
  const sql = `
    INSERT INTO user_source (user_id, source, enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, source) DO UPDATE SET enabled = EXCLUDED.enabled
    RETURNING ${USER_SOURCE_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, [userId, source, enabled]);
  if (!row) throw new Error('setUserSourceEnabled did not return a row.');
  return mapUserSource(row);
}

/** List every source toggle for a user, ordered by source. */
export async function listUserSources(
  db: Queryable,
  userId: string,
): Promise<UserSourceRecord[]> {
  const sql = `
    SELECT ${USER_SOURCE_COLUMNS} FROM user_source
    WHERE user_id = $1
    ORDER BY source ASC
  `;
  const rows = await queryRows(db, sql, [userId]);
  return rows.map(mapUserSource);
}

/** List only the sources a user currently has enabled. */
export async function listEnabledSources(
  db: Queryable,
  userId: string,
): Promise<Source[]> {
  const sql = `
    SELECT source FROM user_source
    WHERE user_id = $1 AND enabled = true
    ORDER BY source ASC
  `;
  const rows = await queryRows<{ source: Source }>(db, sql, [userId]);
  return rows.map((r) => r.source);
}

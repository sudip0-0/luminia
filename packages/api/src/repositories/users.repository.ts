// Users repository — typed query functions over the `user` table.
//
// Supports the Auth_Service and Onboarding_Service: create accounts, look up by
// email/id, update the profile, and apply default goal/depth on creation
// (Requirements 1.x, 26.x). All queries are parameterized; no value is ever
// interpolated into the SQL string.

import { type Queryable, queryMaybeOne } from './queryable.js';
import { mapUser } from './rows.js';
import type { CreateUserInput, UpdateUserProfileInput, UserRecord } from './types.js';

/** Default Daily_Goal applied when omitted at registration (Requirement 1.9). */
export const DEFAULT_DAILY_GOAL_MINUTES = 15;
/** Default Depth_Preference applied when omitted at registration (Requirement 1.9). */
export const DEFAULT_DEPTH_PREFERENCE = 'balanced' as const;

const USER_COLUMNS = `
  id, email, password_hash, display_name, avatar_url, depth_preference,
  daily_goal_minutes, push_enabled, onboarding_completed_at, created_at
`;

/**
 * Create a user account, applying the default Daily_Goal (15) and
 * Depth_Preference (balanced) when omitted (Requirement 1.9). Returns the
 * created row.
 */
export async function createUser(
  db: Queryable,
  input: CreateUserInput,
): Promise<UserRecord> {
  const sql = `
    INSERT INTO "user" (
      email, password_hash, display_name, avatar_url,
      depth_preference, daily_goal_minutes, push_enabled
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING ${USER_COLUMNS}
  `;
  const params = [
    input.email,
    input.passwordHash ?? null,
    input.displayName,
    input.avatarUrl ?? null,
    input.depthPreference ?? DEFAULT_DEPTH_PREFERENCE,
    input.dailyGoalMinutes ?? DEFAULT_DAILY_GOAL_MINUTES,
    input.pushEnabled ?? false,
  ];
  const row = await queryMaybeOne(db, sql, params);
  if (!row) throw new Error('createUser did not return a row.');
  return mapUser(row);
}

/** Find a user by case-insensitive email (the column is `citext`). */
export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<UserRecord | null> {
  const sql = `SELECT ${USER_COLUMNS} FROM "user" WHERE email = $1`;
  const row = await queryMaybeOne(db, sql, [email]);
  return row ? mapUser(row) : null;
}

/** Find a user by id. */
export async function findUserById(
  db: Queryable,
  id: string,
): Promise<UserRecord | null> {
  const sql = `SELECT ${USER_COLUMNS} FROM "user" WHERE id = $1`;
  const row = await queryMaybeOne(db, sql, [id]);
  return row ? mapUser(row) : null;
}

/**
 * Update mutable profile fields. Only the provided fields are changed; omitted
 * fields are left untouched via `COALESCE` against the existing value
 * (Requirements 26.2, 26.3 — rejection of invalid fields is the service's job;
 * this layer persists already-validated values). Returns the updated row, or
 * `null` when no such user exists.
 */
export async function updateUserProfile(
  db: Queryable,
  id: string,
  input: UpdateUserProfileInput,
): Promise<UserRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  const add = (column: string, value: unknown): void => {
    sets.push(`${column} = $${i}`);
    params.push(value);
    i += 1;
  };

  if (input.displayName !== undefined) add('display_name', input.displayName);
  if (input.avatarUrl !== undefined) add('avatar_url', input.avatarUrl);
  if (input.depthPreference !== undefined) {
    add('depth_preference', input.depthPreference);
  }
  if (input.dailyGoalMinutes !== undefined) {
    add('daily_goal_minutes', input.dailyGoalMinutes);
  }
  if (input.pushEnabled !== undefined) add('push_enabled', input.pushEnabled);
  if (input.onboardingCompletedAt !== undefined) {
    add('onboarding_completed_at', input.onboardingCompletedAt);
  }

  if (sets.length === 0) {
    // Nothing to update; return the current row.
    return findUserById(db, id);
  }

  params.push(id);
  const sql = `
    UPDATE "user" SET ${sets.join(', ')}
    WHERE id = $${i}
    RETURNING ${USER_COLUMNS}
  `;
  const row = await queryMaybeOne(db, sql, params);
  return row ? mapUser(row) : null;
}

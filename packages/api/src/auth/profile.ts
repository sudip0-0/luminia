// Auth_Service — profile read and update (Requirement 26).
//
// Two entry points, both pure orchestration over the users repository and the
// shared validators — no Fastify, so every branch is unit-testable with a
// FakeQueryable and never opens a live connection:
//
//   getProfile(deps, userId)
//     - return the user's display name, avatar, Depth_Preference, and
//       Daily_Goal (Requirement 26.1);
//     - return the uniform NOT_FOUND envelope when no such user exists.
//
//   updateProfile(deps, userId, patch)
//     - validate every PROVIDED field up front — display name length 1-50
//       (26.2), Depth_Preference ∈ {quick, balanced, deep}, and Daily_Goal an
//       integer in [5,120] (26.3) — and reject the first invalid field with a
//       uniform VALIDATION_ERROR that identifies the field, persisting NOTHING
//       (no UPDATE is issued on any validation failure, Requirement 26.4);
//     - on an all-valid patch, persist only the provided fields (partial
//       update) and return the updated profile (Requirement 26.2);
//     - return NOT_FOUND when the user does not exist.
//
// Both return a discriminated result: `{ ok: true, profile }` or
// `{ ok: false, error }` carrying the uniform error envelope. Validation runs
// before any database access, so a rejected update never mutates stored state.

import {
  ERROR_CODES,
  makeError,
  validateDailyGoal,
  validateDepth,
  validateDisplayName,
  type ApiErrorEnvelope,
  type Depth,
} from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import {
  findUserById,
  updateUserProfile,
} from '../repositories/users.repository.js';
import type { UpdateUserProfileInput, UserRecord } from '../repositories/types.js';

/** Dependencies shared by both profile flows. */
export interface ProfileDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
}

/**
 * The profile projection returned by the Auth_Service (Requirement 26.1):
 * display name, avatar, Depth_Preference, and Daily_Goal. Intentionally a
 * narrow view of {@link UserRecord} — it never exposes the password hash,
 * email, or other account internals.
 */
export interface Profile {
  /** The user's display name (1-50 chars). */
  displayName: string;
  /** The user's avatar URL, or null when none is set. */
  avatarUrl: string | null;
  /** The user's Depth_Preference. */
  depth: Depth;
  /** The user's Daily_Goal in minutes. */
  dailyGoal: number;
}

/** Discriminated result of {@link getProfile}. */
export type GetProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * A partial profile update (Requirement 26.2). Only the provided fields are
 * validated and persisted; omitted fields are left untouched. Avatar is part of
 * the read projection (26.1) but is not an updatable field per 26.2/26.3, so it
 * is intentionally absent here.
 */
export interface ProfilePatch {
  /** New display name; validated to length 1-50 when provided (26.2). */
  displayName?: string;
  /** New Depth_Preference; validated to {quick,balanced,deep} when provided. */
  depth?: Depth;
  /** New Daily_Goal; validated to an integer in [5,120] when provided (26.3). */
  dailyGoal?: number;
}

/** Discriminated result of {@link updateProfile}. */
export type UpdateProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: ApiErrorEnvelope };

/** Project a persisted {@link UserRecord} onto the public {@link Profile}. */
function toProfile(user: UserRecord): Profile {
  return {
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    depth: user.depthPreference,
    dailyGoal: user.dailyGoalMinutes,
  };
}

/** The uniform NOT_FOUND envelope for a missing user (Requirement 26.1). */
function userNotFound(): ApiErrorEnvelope {
  return makeError(ERROR_CODES.NOT_FOUND, 'User profile was not found.');
}

/**
 * Read the current user's profile (Requirement 26.1). Returns the display name,
 * avatar, Depth_Preference, and Daily_Goal, or the uniform NOT_FOUND envelope
 * when the user does not exist.
 */
export async function getProfile(
  deps: ProfileDeps,
  userId: string,
): Promise<GetProfileResult> {
  const user = await findUserById(deps.db, userId);
  if (!user) {
    return { ok: false, error: userNotFound() };
  }
  return { ok: true, profile: toProfile(user) };
}

/**
 * Update mutable profile fields (Requirements 26.2, 26.3, 26.4).
 *
 * Every provided field is validated BEFORE any database access, so a request
 * carrying any invalid field is rejected with a uniform VALIDATION_ERROR that
 * identifies the offending field and no UPDATE is ever issued — stored state is
 * never mutated on a validation failure (Requirement 26.4). On an all-valid
 * patch, only the provided fields are persisted (partial update) and the
 * updated profile is returned. A patch for a non-existent user resolves to
 * NOT_FOUND.
 */
export async function updateProfile(
  deps: ProfileDeps,
  userId: string,
  patch: ProfilePatch,
): Promise<UpdateProfileResult> {
  const { displayName, depth, dailyGoal } = patch;

  // 26.2/26.3 — validate every PROVIDED field up front. Returning on the first
  // failure (before touching the database) guarantees nothing is persisted on
  // any invalid field (26.4).
  if (displayName !== undefined && !validateDisplayName(displayName)) {
    return {
      ok: false,
      error: makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Display name must be between 1 and 50 characters.',
        { field: 'displayName' },
      ),
    };
  }

  if (depth !== undefined && !validateDepth(depth)) {
    return {
      ok: false,
      error: makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Depth preference must be one of quick, balanced, or deep.',
        { field: 'depth' },
      ),
    };
  }

  if (dailyGoal !== undefined && !validateDailyGoal(dailyGoal)) {
    return {
      ok: false,
      error: makeError(
        ERROR_CODES.VALIDATION_ERROR,
        'Daily goal must be an integer between 5 and 120 minutes.',
        { field: 'dailyGoal' },
      ),
    };
  }

  // All provided fields are valid — persist only those fields (partial update).
  const update: UpdateUserProfileInput = {};
  if (displayName !== undefined) update.displayName = displayName;
  if (depth !== undefined) update.depthPreference = depth;
  if (dailyGoal !== undefined) update.dailyGoalMinutes = dailyGoal;

  const updated = await updateUserProfile(deps.db, userId, update);
  if (!updated) {
    return { ok: false, error: userNotFound() };
  }
  return { ok: true, profile: toProfile(updated) };
}

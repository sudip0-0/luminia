import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import {
  FakeQueryable,
  normalizeSql,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  DEFAULT_DEPTH_PREFERENCE,
} from '../repositories/users.repository.js';
import { getProfile, updateProfile } from './profile.js';

// Verifies the Auth_Service profile read/update (Requirement 26) end-to-end
// over a SQL-dispatching FakeQueryable — no live database. Covers: the profile
// read shape (26.1) and NOT_FOUND; persisting valid updates (26.2); rejecting
// each invalid field with a uniform VALIDATION_ERROR while issuing NO UPDATE so
// stored state is never mutated (26.3, 26.4); and partial updates touching only
// the provided fields (26.2).

const FIXED_NOW = 1_700_000_000_000;

/** A canned `user` row matching the columns the users repository selects. */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-1',
    email: 'reader@example.com',
    password_hash: 'stored-hash',
    display_name: 'Ada Reader',
    avatar_url: 'https://cdn.example.com/a.png',
    depth_preference: DEFAULT_DEPTH_PREFERENCE,
    daily_goal_minutes: DEFAULT_DAILY_GOAL_MINUTES,
    push_enabled: false,
    onboarding_completed_at: null,
    created_at: new Date(FIXED_NOW),
    ...overrides,
  };
}

/** True when the recorded calls include an UPDATE against the user table. */
function issuedUpdate(db: FakeQueryable): boolean {
  return db.calls.some((c) => normalizeSql(c.sql).includes('UPDATE "user"'));
}

/**
 * A {@link FakeQueryable} that dispatches on the SQL it receives. `selectRow`
 * is returned by `findUserById`; the `UPDATE ... RETURNING` echoes the merged
 * row built from the SET parameters so the returned profile reflects the patch.
 * Passing `selectRow: null` simulates a missing user for both flows.
 */
function fakeDb(selectRow: Record<string, unknown> | null = userRow()): FakeQueryable {
  return new FakeQueryable((sql, params): CannedResult => {
    const s = normalizeSql(sql);
    if (s.startsWith('UPDATE "user"')) {
      if (selectRow === null) {
        return { rows: [] };
      }
      // Rebuild the updated row from `SET col = $n, ...` so the echoed row
      // reflects exactly the columns the service chose to update.
      const merged = { ...selectRow };
      const setClause = s.slice(s.indexOf('SET') + 3, s.indexOf(' WHERE '));
      const assignments = setClause.split(',').map((a) => a.trim());
      for (const assignment of assignments) {
        const match = /^([a-z_]+) = \$(\d+)$/.exec(assignment);
        if (match) {
          const column = match[1];
          const paramIndex = Number(match[2]) - 1;
          merged[column] = params[paramIndex];
        }
      }
      return { rows: [merged] };
    }
    if (s.includes('FROM "user" WHERE id')) {
      return { rows: selectRow ? [selectRow] : [] };
    }
    return { rows: [] };
  });
}

describe('getProfile', () => {
  it('returns display name, avatar, Depth_Preference, and Daily_Goal (26.1)', async () => {
    const db = fakeDb(
      userRow({
        display_name: 'Ada Reader',
        avatar_url: 'https://cdn.example.com/a.png',
        depth_preference: 'deep',
        daily_goal_minutes: 45,
      }),
    );
    const result = await getProfile({ db }, 'u-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual({
      displayName: 'Ada Reader',
      avatarUrl: 'https://cdn.example.com/a.png',
      depth: 'deep',
      dailyGoal: 45,
    });
  });

  it('returns a null avatar when none is set (26.1)', async () => {
    const db = fakeDb(userRow({ avatar_url: null }));
    const result = await getProfile({ db }, 'u-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.avatarUrl).toBeNull();
  });

  it('returns NOT_FOUND when the user does not exist', async () => {
    const db = fakeDb(null);
    const result = await getProfile({ db }, 'missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe('updateProfile', () => {
  it('persists valid display name, depth, and Daily_Goal and returns the updated profile (26.2)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', {
      displayName: 'New Name',
      depth: 'quick',
      dailyGoal: 90,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      displayName: 'New Name',
      depth: 'quick',
      dailyGoal: 90,
    });

    // An UPDATE was issued carrying exactly the three provided columns.
    const update = db.calls.find((c) => normalizeSql(c.sql).startsWith('UPDATE "user"'));
    expect(update).toBeDefined();
    const setClause = normalizeSql(update!.sql).slice(
      normalizeSql(update!.sql).indexOf('SET') + 3,
      normalizeSql(update!.sql).indexOf(' WHERE '),
    );
    expect(setClause).toContain('display_name = $1');
    expect(setClause).toContain('depth_preference = $2');
    expect(setClause).toContain('daily_goal_minutes = $3');
    expect(update!.params).toEqual(['New Name', 'quick', 90, 'u-1']);
  });

  it('rejects an out-of-range display name and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', {
      displayName: 'x'.repeat(51),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'displayName' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('rejects an empty display name and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', { displayName: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'displayName' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('rejects an invalid Depth_Preference and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', {
      depth: 'shallow' as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'depth' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('rejects a below-range Daily_Goal and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', { dailyGoal: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'dailyGoal' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('rejects an above-range Daily_Goal and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', { dailyGoal: 121 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'dailyGoal' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('rejects a non-integer Daily_Goal and issues NO update (26.3, 26.4)', async () => {
    const db = fakeDb(userRow());
    const result = await updateProfile({ db }, 'u-1', { dailyGoal: 30.5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(issuedUpdate(db)).toBe(false);
  });

  it('mutates no stored state when one of several fields is invalid (26.4)', async () => {
    const db = fakeDb(userRow());
    // displayName + dailyGoal are valid, but depth is invalid — the whole
    // request must be rejected with no UPDATE issued.
    const result = await updateProfile({ db }, 'u-1', {
      displayName: 'Valid Name',
      dailyGoal: 60,
      depth: 'nope' as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'depth' });
    expect(issuedUpdate(db)).toBe(false);
  });

  it('updates only the provided field on a partial update (26.2)', async () => {
    const db = fakeDb(
      userRow({ depth_preference: 'balanced', daily_goal_minutes: 15 }),
    );
    const result = await updateProfile({ db }, 'u-1', { dailyGoal: 75 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only daily goal changed; depth and display name are preserved.
    expect(result.profile.dailyGoal).toBe(75);
    expect(result.profile.depth).toBe('balanced');
    expect(result.profile.displayName).toBe('Ada Reader');

    const update = db.calls.find((c) => normalizeSql(c.sql).startsWith('UPDATE "user"'));
    expect(update).toBeDefined();
    const sql = normalizeSql(update!.sql);
    // Scope the column assertions to the SET clause; the RETURNING clause names
    // every column regardless of what was updated.
    const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf(' WHERE '));
    expect(setClause).toContain('daily_goal_minutes = $1');
    expect(setClause).not.toContain('display_name');
    expect(setClause).not.toContain('depth_preference');
    expect(update!.params).toEqual([75, 'u-1']);
  });

  it('returns NOT_FOUND when updating a non-existent user', async () => {
    const db = fakeDb(null);
    const result = await updateProfile({ db }, 'missing', { dailyGoal: 30 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

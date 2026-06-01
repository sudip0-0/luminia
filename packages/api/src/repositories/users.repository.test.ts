import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from './fake-queryable.js';
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  DEFAULT_DEPTH_PREFERENCE,
  createUser,
  findUserByEmail,
  findUserById,
  updateUserProfile,
} from './users.repository.js';

// Verifies the users repository builds correct parameterized SQL and maps the
// snake_case row to the camelCase UserRecord (Requirements 1.x, 26.x).

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    email: 'a@b.com',
    password_hash: 'hash',
    display_name: 'Ada',
    avatar_url: null,
    depth_preference: 'balanced',
    daily_goal_minutes: 15,
    push_enabled: false,
    onboarding_completed_at: null,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createUser', () => {
  it('inserts with parameterized values and applies goal/depth defaults', async () => {
    const db = new FakeQueryable([{ rows: [userRow()] }]);
    const user = await createUser(db, {
      email: 'a@b.com',
      passwordHash: 'hash',
      displayName: 'Ada',
    });

    const { sql, params } = db.lastCall;
    expect(normalizeSql(sql)).toContain('INSERT INTO "user"');
    expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7)');
    // defaults applied for depth (idx 4) and daily goal (idx 5) and push (idx 6)
    expect(params).toEqual([
      'a@b.com',
      'hash',
      'Ada',
      null,
      DEFAULT_DEPTH_PREFERENCE,
      DEFAULT_DAILY_GOAL_MINUTES,
      false,
    ]);
    expect(user).toEqual({
      id: 'u-1',
      email: 'a@b.com',
      passwordHash: 'hash',
      displayName: 'Ada',
      avatarUrl: null,
      depthPreference: 'balanced',
      dailyGoalMinutes: 15,
      pushEnabled: false,
      onboardingCompletedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('passes explicit goal/depth and a null password through', async () => {
    const db = new FakeQueryable([
      { rows: [userRow({ password_hash: null, depth_preference: 'deep', daily_goal_minutes: 90 })] },
    ]);
    await createUser(db, {
      email: 'x@y.com',
      passwordHash: null,
      displayName: 'Grace',
      depthPreference: 'deep',
      dailyGoalMinutes: 90,
    });
    expect(db.lastCall.params).toEqual([
      'x@y.com',
      null,
      'Grace',
      null,
      'deep',
      90,
      false,
    ]);
  });
});

describe('findUserByEmail / findUserById', () => {
  it('queries by email with a single param and maps the row', async () => {
    const db = new FakeQueryable([{ rows: [userRow()] }]);
    const user = await findUserByEmail(db, 'a@b.com');
    expect(db.lastCall.sql).toContain('WHERE email = $1');
    expect(db.lastCall.params).toEqual(['a@b.com']);
    expect(user?.email).toBe('a@b.com');
  });

  it('returns null when no row is found', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await findUserById(db, 'missing')).toBeNull();
    expect(db.lastCall.params).toEqual(['missing']);
  });
});

describe('updateUserProfile', () => {
  it('builds a SET list only for provided fields and parameterizes the id last', async () => {
    const db = new FakeQueryable([
      { rows: [userRow({ display_name: 'Ada L', daily_goal_minutes: 30 })] },
    ]);
    const user = await updateUserProfile(db, 'u-1', {
      displayName: 'Ada L',
      dailyGoalMinutes: 30,
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('display_name = $1');
    expect(sql).toContain('daily_goal_minutes = $2');
    expect(sql).toContain('WHERE id = $3');
    expect(params).toEqual(['Ada L', 30, 'u-1']);
    expect(user?.displayName).toBe('Ada L');
    expect(user?.dailyGoalMinutes).toBe(30);
  });

  it('with no fields, returns the current row via a select', async () => {
    const db = new FakeQueryable([{ rows: [userRow()] }]);
    await updateUserProfile(db, 'u-1', {});
    expect(db.lastCall.sql).toContain('SELECT');
    expect(db.lastCall.params).toEqual(['u-1']);
  });

  it('returns null when the update affects no row', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await updateUserProfile(db, 'missing', { displayName: 'X' })).toBeNull();
  });
});

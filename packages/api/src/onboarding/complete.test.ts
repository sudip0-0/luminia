import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import { FakeQueryable, type RecordedQuery } from '../repositories/fake-queryable.js';
import {
  completeOnboarding,
  type CompleteOnboardingDeps,
  type CompleteOnboardingInput,
} from './complete.js';

// Verifies Onboarding_Service completion (Requirements 3.2-3.7). The submission
// is all-or-nothing: any validation failure persists nothing; a valid
// submission persists each DISTINCT topic with source=onboarding/weight=1.0,
// stores the depth + Daily_Goal on the user, and persists the per-source
// enabled state.

const USER_ID = 'u-1';
const FIXED_NOW = new Date('2024-03-01T12:00:00.000Z');

/** A canned `user` row returned by the `UPDATE "user" ... RETURNING` write. */
function userRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    email: 'reader@example.com',
    password_hash: null,
    display_name: 'Reader',
    avatar_url: null,
    depth_preference: 'balanced',
    daily_goal_minutes: 15,
    push_enabled: false,
    onboarding_completed_at: FIXED_NOW,
    created_at: FIXED_NOW,
  };
}

/**
 * A {@link FakeQueryable} that knows the set of topic ids that exist. It
 * answers the `findTopicsByIds` read with the matching topic rows and echoes
 * each write back as a valid RETURNING row so the repositories map cleanly.
 */
function makeDb(existingTopicIds: readonly string[]): FakeQueryable {
  const existing = new Set(existingTopicIds);
  return new FakeQueryable((sql, params) => {
    if (/FROM topic/i.test(sql)) {
      const rows = params
        .filter((id): id is string => existing.has(id as string))
        .map((id) => ({
          id,
          slug: `slug-${String(id)}`,
          label: String(id),
          parent_id: null,
          color: '#000000',
          icon_name: 'icon',
          centroid: null,
        }));
      return { rows };
    }
    if (/INSERT INTO user_topic/i.test(sql)) {
      return {
        rows: [
          {
            user_id: params[0],
            topic_id: params[1],
            weight: params[2],
            source: params[3],
            muted: params[4],
            created_at: FIXED_NOW,
          },
        ],
      };
    }
    if (/INSERT INTO user_source/i.test(sql)) {
      return {
        rows: [
          { user_id: params[0], source: params[1], enabled: params[2] },
        ],
      };
    }
    if (/UPDATE "user"/i.test(sql)) {
      return { rows: [userRow()] };
    }
    return { rows: [] };
  });
}

/** The INSERT/UPDATE calls recorded by the fake (i.e. the persistence writes). */
function writeCalls(db: FakeQueryable): RecordedQuery[] {
  return db.calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql));
}

function deps(db: FakeQueryable): CompleteOnboardingDeps {
  return { db, now: () => FIXED_NOW };
}

function validInput(
  overrides: Partial<CompleteOnboardingInput> = {},
): CompleteOnboardingInput {
  return {
    topicIds: ['t-1', 't-2', 't-3'],
    depth: 'balanced',
    dailyGoal: 30,
    ...overrides,
  };
}

describe('completeOnboarding — validation persists nothing (3.2-3.4)', () => {
  it('rejects fewer than 3 topics and writes nothing (3.2)', async () => {
    const db = makeDb(['t-1', 't-2']);
    const result = await completeOnboarding(deps(db), USER_ID, {
      topicIds: ['t-1', 't-2'],
      depth: 'balanced',
      dailyGoal: 30,
    });

    expect(result.status).toBe('validation-error');
    if (result.status === 'validation-error') {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(writeCalls(db)).toHaveLength(0);
    // Count is checked before any DB access at all.
    expect(db.calls).toHaveLength(0);
  });

  it('rejects more than 20 topics and writes nothing (3.2)', async () => {
    const topicIds = Array.from({ length: 21 }, (_, i) => `t-${i}`);
    const db = makeDb(topicIds);
    const result = await completeOnboarding(
      deps(db),
      USER_ID,
      validInput({ topicIds }),
    );

    expect(result.status).toBe('validation-error');
    expect(writeCalls(db)).toHaveLength(0);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an invalid depth and writes nothing (3.4)', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const result = await completeOnboarding(
      deps(db),
      USER_ID,
      validInput({ depth: 'shallow' as never }),
    );

    expect(result.status).toBe('validation-error');
    if (result.status === 'validation-error') {
      expect(result.error.error.details).toMatchObject({ fields: ['depth'] });
    }
    expect(writeCalls(db)).toHaveLength(0);
  });

  it('rejects a Daily_Goal outside [5,120] and writes nothing (3.4)', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const tooLow = await completeOnboarding(
      deps(db),
      USER_ID,
      validInput({ dailyGoal: 4 }),
    );
    const tooHigh = await completeOnboarding(
      deps(makeDb(['t-1', 't-2', 't-3'])),
      USER_ID,
      validInput({ dailyGoal: 121 }),
    );
    const nonInteger = await completeOnboarding(
      deps(makeDb(['t-1', 't-2', 't-3'])),
      USER_ID,
      validInput({ dailyGoal: 30.5 }),
    );

    expect(tooLow.status).toBe('validation-error');
    expect(tooHigh.status).toBe('validation-error');
    expect(nonInteger.status).toBe('validation-error');
    expect(writeCalls(db)).toHaveLength(0);
  });

  it('rejects an unknown topic id and writes nothing (3.3)', async () => {
    // Only t-1 and t-2 exist; t-missing does not.
    const db = makeDb(['t-1', 't-2']);
    const result = await completeOnboarding(deps(db), USER_ID, {
      topicIds: ['t-1', 't-2', 't-missing'],
      depth: 'deep',
      dailyGoal: 45,
    });

    expect(result.status).toBe('validation-error');
    if (result.status === 'validation-error') {
      expect(result.error.error.details).toMatchObject({
        unrecognizedTopicIds: ['t-missing'],
      });
    }
    // The existence read ran, but no write occurred.
    expect(writeCalls(db)).toHaveLength(0);
    expect(db.calls.some((c) => /FROM topic/i.test(c.sql))).toBe(true);
  });

  it('rejects an unrecognized source toggle and writes nothing (3.7)', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const result = await completeOnboarding(
      deps(db),
      USER_ID,
      validInput({ sources: { bluesky: true } as never }),
    );

    expect(result.status).toBe('validation-error');
    expect(writeCalls(db)).toHaveLength(0);
  });
});

describe('completeOnboarding — success persists everything (3.5-3.7)', () => {
  it('persists each topic with source=onboarding/weight=1.0, the depth+goal, and sources', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const result = await completeOnboarding(deps(db), USER_ID, {
      topicIds: ['t-1', 't-2', 't-3'],
      depth: 'deep',
      dailyGoal: 45,
      sources: { wikipedia: true, medium: false },
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.persisted).toEqual({
      topicIds: ['t-1', 't-2', 't-3'],
      depth: 'deep',
      dailyGoalMinutes: 45,
      sources: { wikipedia: true, medium: false },
      onboardingCompletedAt: FIXED_NOW.toISOString(),
    });

    // (3.5) Each distinct topic is upserted with onboarding/1.0.
    const topicWrites = db.calls.filter((c) =>
      /INSERT INTO user_topic/i.test(c.sql),
    );
    expect(topicWrites).toHaveLength(3);
    for (const call of topicWrites) {
      // params = [userId, topicId, weight, source, muted]
      expect(call.params[0]).toBe(USER_ID);
      expect(call.params[2]).toBe(1.0);
      expect(call.params[3]).toBe('onboarding');
    }
    expect(topicWrites.map((c) => c.params[1])).toEqual(['t-1', 't-2', 't-3']);

    // (3.7) Each provided source toggle is persisted.
    const sourceWrites = db.calls.filter((c) =>
      /INSERT INTO user_source/i.test(c.sql),
    );
    expect(sourceWrites).toHaveLength(2);
    expect(
      sourceWrites.map((c) => [c.params[1], c.params[2]]),
    ).toEqual([
      ['wikipedia', true],
      ['medium', false],
    ]);

    // (3.6) The depth, Daily_Goal, and completion timestamp are stored.
    const userWrite = db.calls.find((c) => /UPDATE "user"/i.test(c.sql));
    expect(userWrite).toBeDefined();
    expect(userWrite?.params).toContain('deep');
    expect(userWrite?.params).toContain(45);
    expect(userWrite?.params).toContain(FIXED_NOW.toISOString());
  });

  it('succeeds with no source toggles, persisting only topics + profile', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const result = await completeOnboarding(
      deps(db),
      USER_ID,
      validInput(),
    );

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.persisted.sources).toEqual({});
    }
    expect(
      db.calls.some((c) => /INSERT INTO user_source/i.test(c.sql)),
    ).toBe(false);
  });

  it('runs all writes inside the injected atomic unit exactly once', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    let transactCalls = 0;
    let writesDuringTransaction = 0;
    const result = await completeOnboarding(
      {
        db,
        now: () => FIXED_NOW,
        transact: async (fn) => {
          transactCalls += 1;
          const before = writeCalls(db).length;
          const out = await fn(db);
          writesDuringTransaction = writeCalls(db).length - before;
          return out;
        },
      },
      USER_ID,
      validInput({ sources: { arxiv: true } }),
    );

    expect(result.status).toBe('completed');
    expect(transactCalls).toBe(1);
    // 3 topic upserts + 1 source + 1 user update all happen in the unit.
    expect(writesDuringTransaction).toBe(5);
  });
});

describe('completeOnboarding — duplicate topics are de-duplicated (3.5)', () => {
  it('persists each distinct topic exactly once, preserving first-seen order', async () => {
    const db = makeDb(['t-1', 't-2', 't-3']);
    const result = await completeOnboarding(deps(db), USER_ID, {
      topicIds: ['t-1', 't-2', 't-1', 't-3', 't-2'],
      depth: 'quick',
      dailyGoal: 10,
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.persisted.topicIds).toEqual(['t-1', 't-2', 't-3']);
    }

    const topicWrites = db.calls.filter((c) =>
      /INSERT INTO user_topic/i.test(c.sql),
    );
    expect(topicWrites).toHaveLength(3);
    expect(topicWrites.map((c) => c.params[1])).toEqual(['t-1', 't-2', 't-3']);

    // The existence read is also de-duplicated to the distinct set.
    const topicRead = db.calls.find((c) => /FROM topic/i.test(c.sql));
    expect(topicRead?.params).toEqual(['t-1', 't-2', 't-3']);
  });

  it('persists a single distinct topic once when the raw selection repeats it', async () => {
    // The count check (3.2) runs on the raw selection, before de-duplication,
    // so 3 raw entries pass the count gate; they collapse to 1 distinct topic
    // which must still be persisted exactly once.
    const db = makeDb(['t-1']);
    const result = await completeOnboarding(deps(db), USER_ID, {
      topicIds: ['t-1', 't-1', 't-1'],
      depth: 'balanced',
      dailyGoal: 15,
    });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.persisted.topicIds).toEqual(['t-1']);
    }
    const topicWrites = db.calls.filter((c) =>
      /INSERT INTO user_topic/i.test(c.sql),
    );
    expect(topicWrites).toHaveLength(1);
  });
});

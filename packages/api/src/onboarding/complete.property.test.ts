// Feature: lumina, Property 4: Onboarding persistence is all-or-nothing and normalized
//
// Property-based coverage for `completeOnboarding` (Requirements 3.2-3.6).
//
// Property 4 (design.md): *For any* onboarding completion request, if the topic
// count is outside [3,20], any topic id is unrecognized, the depth is invalid,
// or the daily goal is outside [5,120], then nothing is persisted; otherwise
// each *distinct* selected topic is persisted exactly once with
// `source = onboarding` and `weight = 1.0`, and the depth and daily goal are
// stored on the account.
//
// The two properties below assert:
//   (1) on ANY validation failure (each invalid dimension is generated) the
//       result is `validation-error` and NO INSERT/UPDATE write was issued; and
//   (2) on a fully-valid request the result is `completed`, exactly the
//       DISTINCT selected topics are upserted (one INSERT INTO user_topic per
//       distinct id, each with source=onboarding and weight=1.0), and the
//       `UPDATE "user"` write carries the chosen depth and daily goal.
//
// The validity of each generated request is decided by an INDEPENDENT oracle
// (re-deriving the [3,20] count rule, the existing-topic set, the {quick,
// balanced, deep} depth set, and the [5,120] integer goal rule) rather than by
// calling the implementation, so the test is a true second source of truth.
// It reuses the SQL-dispatching FakeQueryable pattern from complete.test.ts: a
// fake that knows which topic ids exist and records every write call. Each
// property runs a minimum of 100 generated iterations. No implementation file
// is modified.
//
// Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DEPTHS, type Depth } from '@lumina/shared';
import {
  FakeQueryable,
  type RecordedQuery,
} from '../repositories/fake-queryable.js';
import {
  completeOnboarding,
  ONBOARDING_TOPIC_WEIGHT,
  type CompleteOnboardingInput,
} from './complete.js';

const RUNS = { numRuns: 200 } as const;
const USER_ID = 'u-prop-4';
const FIXED_NOW = new Date('2024-03-01T12:00:00.000Z');

// --- FakeQueryable factory (mirrors complete.test.ts) ----------------------

/**
 * A {@link FakeQueryable} that knows the set of topic ids that exist. It answers
 * the `findTopicsByIds` read with the matching topic rows and echoes every write
 * back as a valid RETURNING row so the repositories map cleanly.
 */
function makeDb(existingTopicIds: Iterable<string>): FakeQueryable {
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
        rows: [{ user_id: params[0], source: params[1], enabled: params[2] }],
      };
    }
    if (/UPDATE "user"/i.test(sql)) {
      return {
        rows: [
          {
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
          },
        ],
      };
    }
    return { rows: [] };
  });
}

/** The INSERT/UPDATE calls recorded by the fake (i.e. the persistence writes). */
function writeCalls(db: FakeQueryable): RecordedQuery[] {
  return db.calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql));
}

/** The INSERT INTO user_topic writes recorded by the fake. */
function topicWrites(db: FakeQueryable): RecordedQuery[] {
  return db.calls.filter((c) => /INSERT INTO user_topic/i.test(c.sql));
}

// --- Generators ------------------------------------------------------------

// Existing-topic ids carry a `t-` prefix; "unknown" ids use a disjoint prefix
// so they can never collide with the existing universe.
const existingIdArb = fc.integer({ min: 0, max: 999 }).map((n) => `t-${n}`);
const unknownIdArb = fc
  .integer({ min: 0, max: 999 })
  .map((n) => `missing-${n}`);

// A universe of >= 20 distinct existing topics so a fully-valid request can
// draw up to the 20-topic maximum.
const existingPoolArb = fc.uniqueArray(existingIdArb, {
  minLength: 20,
  maxLength: 40,
});

const validDepthArb = fc.constantFrom<Depth>(...DEPTHS);
const validGoalArb = fc.integer({ min: 5, max: 120 });

// Depths that are NOT one of {quick, balanced, deep}.
const invalidDepthArb = fc
  .oneof(
    fc.constantFrom('shallow', 'medium', 'DEEP', 'Balanced', 'quick ', ''),
    fc.string(),
  )
  .filter((s) => !(DEPTHS as readonly string[]).includes(s));

// Daily goals outside [5,120]: below range, above range, or non-integer.
const invalidGoalArb = fc.oneof(
  fc.integer({ min: -200, max: 4 }),
  fc.integer({ min: 121, max: 2000 }),
  fc
    .double({ min: 5, max: 120, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),
);

/**
 * A fully-valid request drawn from `pool`: raw topic list of length 3-20 (which
 * may contain duplicates, exercising the distinct-collapse rule), a valid depth,
 * and an in-range integer daily goal.
 */
function validRequestArb(pool: readonly string[]): fc.Arbitrary<CompleteOnboardingInput> {
  return fc.record({
    topicIds: fc.array(fc.constantFrom(...pool), {
      minLength: 3,
      maxLength: 20,
    }),
    depth: validDepthArb,
    dailyGoal: validGoalArb,
  });
}

interface ValidCase {
  pool: string[];
  request: CompleteOnboardingInput;
}

const validCaseArb: fc.Arbitrary<ValidCase> = existingPoolArb.chain((pool) =>
  validRequestArb(pool).map((request) => ({ pool, request })),
);

type InvalidDimension = 'count-low' | 'count-high' | 'unknown-topic' | 'depth' | 'goal';

interface InvalidCase {
  pool: string[];
  dimension: InvalidDimension;
  request: CompleteOnboardingInput;
}

/**
 * An invalid request that violates exactly one named dimension while leaving the
 * other dimensions valid, so each invalid path is exercised independently.
 */
const invalidCaseArb: fc.Arbitrary<InvalidCase> = existingPoolArb.chain((pool) => {
  const fromPool = fc.constantFrom(...pool);

  const countLow: fc.Arbitrary<InvalidCase> = fc
    .record({
      topicIds: fc.array(fromPool, { minLength: 0, maxLength: 2 }),
      depth: validDepthArb,
      dailyGoal: validGoalArb,
    })
    .map((request) => ({ pool, dimension: 'count-low' as const, request }));

  const countHigh: fc.Arbitrary<InvalidCase> = fc
    .record({
      topicIds: fc.array(fromPool, { minLength: 21, maxLength: 30 }),
      depth: validDepthArb,
      dailyGoal: validGoalArb,
    })
    .map((request) => ({ pool, dimension: 'count-high' as const, request }));

  // Count stays in [3,20]; one entry is an unknown id so existence is the only
  // failing rule.
  const unknownTopic: fc.Arbitrary<InvalidCase> = fc
    .record({
      known: fc.array(fromPool, { minLength: 2, maxLength: 19 }),
      unknown: unknownIdArb,
      depth: validDepthArb,
      dailyGoal: validGoalArb,
    })
    .map(({ known, unknown, depth, dailyGoal }) => ({
      pool,
      dimension: 'unknown-topic' as const,
      request: { topicIds: [...known, unknown], depth, dailyGoal },
    }));

  const badDepth: fc.Arbitrary<InvalidCase> = fc
    .record({
      topicIds: fc.array(fromPool, { minLength: 3, maxLength: 20 }),
      depth: invalidDepthArb,
      dailyGoal: validGoalArb,
    })
    .map(({ topicIds, depth, dailyGoal }) => ({
      pool,
      dimension: 'depth' as const,
      request: { topicIds, depth: depth as unknown as Depth, dailyGoal },
    }));

  const badGoal: fc.Arbitrary<InvalidCase> = fc
    .record({
      topicIds: fc.array(fromPool, { minLength: 3, maxLength: 20 }),
      depth: validDepthArb,
      dailyGoal: invalidGoalArb,
    })
    .map((request) => ({ pool, dimension: 'goal' as const, request }));

  return fc.oneof(countLow, countHigh, unknownTopic, badDepth, badGoal);
});

// --- Independent validity oracle -------------------------------------------

/** Re-derive whether a request should pass validation, independent of impl. */
function oracleIsValid(
  pool: readonly string[],
  request: CompleteOnboardingInput,
): boolean {
  const { topicIds, depth, dailyGoal } = request;
  const existing = new Set(pool);
  const countOk = topicIds.length >= 3 && topicIds.length <= 20;
  const depthOk = (DEPTHS as readonly string[]).includes(depth as string);
  const goalOk =
    Number.isInteger(dailyGoal) && dailyGoal >= 5 && dailyGoal <= 120;
  const topicsOk = topicIds.every((id) => existing.has(id));
  return countOk && depthOk && goalOk && topicsOk;
}

// --- Properties ------------------------------------------------------------

describe('Property 4 - onboarding persistence is all-or-nothing (Req 3.2-3.4)', () => {
  it('persists NOTHING and returns validation-error on any invalid dimension', async () => {
    await fc.assert(
      fc.asyncProperty(invalidCaseArb, async ({ pool, request }) => {
        // The oracle confirms the generated request is genuinely invalid.
        expect(oracleIsValid(pool, request)).toBe(false);

        const db = makeDb(pool);
        const result = await completeOnboarding(
          { db, now: () => FIXED_NOW },
          USER_ID,
          request,
        );

        expect(result.status).toBe('validation-error');
        // All-or-nothing: not a single INSERT/UPDATE was issued.
        expect(writeCalls(db)).toHaveLength(0);
      }),
      RUNS,
    );
  });
});

describe('Property 4 - onboarding persistence is normalized on success (Req 3.5, 3.6)', () => {
  it('upserts exactly the DISTINCT topics (onboarding/1.0) and stores depth + goal', async () => {
    await fc.assert(
      fc.asyncProperty(validCaseArb, async ({ pool, request }) => {
        // The oracle confirms the generated request is genuinely valid.
        expect(oracleIsValid(pool, request)).toBe(true);

        const db = makeDb(pool);
        const result = await completeOnboarding(
          { db, now: () => FIXED_NOW },
          USER_ID,
          request,
        );

        expect(result.status).toBe('completed');
        if (result.status !== 'completed') return;

        const distinct = [...new Set(request.topicIds)];

        // (3.5) Exactly one user_topic upsert per DISTINCT topic, in first-seen
        // order, each with source=onboarding and weight=1.0.
        const writes = topicWrites(db);
        expect(writes).toHaveLength(distinct.length);
        expect(writes.map((c) => c.params[1])).toEqual(distinct);
        for (const call of writes) {
          expect(call.params[0]).toBe(USER_ID);
          expect(call.params[2]).toBe(ONBOARDING_TOPIC_WEIGHT);
          expect(call.params[3]).toBe('onboarding');
        }

        // The persisted payload reflects the DISTINCT set exactly once.
        expect(result.persisted.topicIds).toEqual(distinct);

        // (3.6) The single user UPDATE carries the chosen depth and daily goal.
        const userWrites = db.calls.filter((c) => /UPDATE "user"/i.test(c.sql));
        expect(userWrites).toHaveLength(1);
        expect(userWrites[0].params).toContain(request.depth);
        expect(userWrites[0].params).toContain(request.dailyGoal);
      }),
      RUNS,
    );
  });
});

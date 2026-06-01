// Feature: lumina, Property 3: Account lockout triggers exactly at the threshold within the window
//
// Property-based coverage for Auth_Service account lockout (Requirement 2.7):
// "IF 5 consecutive login requests for the same account fail within a 15-minute
// window, THEN THE Auth_Service SHALL lock that account for 15 minutes and
// reject any further login request for that account during the lockout period
// with a generic authentication error."
//
// Property 3 (design.md): *For any* timeline of failed login attempts for a
// single account, the account is locked if and only if at least 5 of those
// failures fall within a 15-minute sliding window, and once locked it remains
// locked for 15 minutes regardless of further attempts.
//
// The real `login` orchestration is exercised end-to-end over a SQL-dispatching
// FakeQueryable returning a valid user (with a known bcrypt hash) and an
// in-memory RedisLike wrapped in the real RedisKeyStore — no live DB or Redis.
// Because the in-memory fake does NOT auto-expire keys, every attempt driven in
// a single test falls inside one 15-minute window, so the "within the window"
// quantifier is realized directly: a reference counter models the cumulative
// failure count and the implementation is asserted to lock exactly when that
// model count first reaches LOCKOUT_THRESHOLD (5), never before. The 15-minute
// durations are checked via the TTLs the store records on the lock and counter
// keys.
//
// Three complementary sub-properties are exercised (each >= 100 iterations):
//   (1) Pure-failure timeline of generated length (covering <5, ==5, >5): the
//       account is unlocked while the cumulative failure count is < 5 and locks
//       on exactly the 5th failure; the counter increments per failure until
//       the lock, then freezes.
//   (2) Once locked, the account stays locked for any subsequent timeline of
//       attempts — including ones presenting the CORRECT password — every such
//       attempt is rejected with the generic error and consumes no further
//       counter increment.
//   (3) General timeline mixing wrong/correct passwords: the implementation's
//       lock state and failure counter match a reference model in which a
//       successful login clears the counter (so lockout requires 5 *consecutive*
//       failures within the window), confirming "locked iff >= 5 failures in
//       the window".
//
// No implementation files are modified; the flow is observed only through the
// public `login` API and the RedisKeyStore's recorded state.
//
// Validates: Requirements 2.7

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { hash as bcryptHash } from 'bcryptjs';
import {
  FakeQueryable,
  normalizeSql,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import { RedisKeyStore, type RedisLike } from '../redis/client.js';
import {
  LOCKOUT_TTL_SECONDS,
  LOGIN_FAIL_WINDOW_SECONDS,
  lockoutKey,
  loginFailKey,
} from '../redis/keys.js';
import { REFRESH_TOKEN_TTL_SECONDS, TEST_DEFAULT_ACCESS_TOKEN_SECRET } from './config.js';
import {
  LOCKOUT_THRESHOLD,
  genericAuthError,
  login,
  type LoginDeps,
} from './session.js';

const RUNS = { numRuns: 100 } as const;
// Generous per-test timeout: each iteration drives several real `login` calls,
// and each wrong/correct password attempt runs a bcrypt comparison.
const TIMEOUT_MS = 120_000;

const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;
const tokenOptions = { secret: TEST_DEFAULT_ACCESS_TOKEN_SECRET, now: clock };

const EMAIL = 'reader@example.com';
const USER_ID = 'u-1';
const CORRECT_PASSWORD = 'a-correct-password';
const WRONG_PASSWORD = 'a-wrong-password';

/**
 * A valid bcrypt digest of {@link CORRECT_PASSWORD}, computed once. The cost
 * factor (4, the bcrypt minimum) is intentionally low: it does not affect
 * correctness — only how fast each of the many per-iteration comparisons runs —
 * keeping a 100+ iteration property test fast. `verifyPassword` reads the cost
 * from the stored digest, so the production hashing cost is irrelevant here.
 */
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await bcryptHash(CORRECT_PASSWORD, 4);
});

/**
 * Minimal in-memory {@link RedisLike} (mirrors the redis client + session
 * tests). It deliberately does NOT auto-expire keys, so every attempt within a
 * single test stays inside one sliding window — the precondition that lets a
 * reference counter model "failures within the 15-minute window".
 */
class InMemoryRedis implements RedisLike {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.strings.set(key, value);
    if (ttlSeconds !== undefined) this.ttls.set(key, ttlSeconds);
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async expire(key: string, ttlSeconds: number): Promise<void> {
    this.ttls.set(key, ttlSeconds);
  }
  async exists(key: string): Promise<boolean> {
    return this.strings.has(key) || this.sets.has(key);
  }
  async del(key: string): Promise<void> {
    this.strings.delete(key);
    this.sets.delete(key);
    this.ttls.delete(key);
  }
  async sadd(key: string, members: string[]): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.sets.set(key, set);
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async sismember(key: string, member: string): Promise<boolean> {
    return this.sets.get(key)?.has(member) ?? false;
  }
}

/** A canned `user` row matching the columns the users repository selects. */
function userRow(): Record<string, unknown> {
  return {
    id: USER_ID,
    email: EMAIL,
    password_hash: PASSWORD_HASH,
    display_name: 'reader',
    avatar_url: null,
    depth_preference: 'balanced',
    daily_goal_minutes: 15,
    push_enabled: false,
    onboarding_completed_at: null,
    created_at: new Date(FIXED_NOW),
  };
}

/** A canned `refresh_token` row for the success-path issuance INSERT. */
function refreshRow(): Record<string, unknown> {
  return {
    id: 'rt-1',
    user_id: USER_ID,
    token_hash: '__hash__',
    expires_at: new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000),
    revoked_at: null,
    created_at: new Date(FIXED_NOW),
  };
}

/** A SQL-dispatching fake returning the valid user and supporting issuance. */
function fakeDb(): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM "user" WHERE email')) return { rows: [userRow()] };
    if (s.includes('INSERT INTO refresh_token')) return { rows: [refreshRow()] };
    return { rows: [] };
  });
}

/** A fresh login deps bundle backed by a SQL fake and the real RedisKeyStore. */
function makeHarness(): {
  deps: LoginDeps;
  redis: RedisKeyStore;
  store: InMemoryRedis;
} {
  const db = fakeDb();
  const store = new InMemoryRedis();
  const redis = new RedisKeyStore(store);
  return { deps: { db, redis, tokenOptions }, redis, store };
}

/** Run one login attempt; `wrong` selects the wrong vs the correct password. */
async function attempt(deps: LoginDeps, wrong: boolean) {
  return login(deps, {
    email: EMAIL,
    password: wrong ? WRONG_PASSWORD : CORRECT_PASSWORD,
  });
}

// --- Generators ------------------------------------------------------------

// A count of failed attempts spanning below, at, and above the threshold.
const failureCount = fc.integer({ min: 0, max: LOCKOUT_THRESHOLD * 2 + 2 });

// A timeline of attempts: `true` = wrong-password attempt, `false` = correct.
const attemptTimeline = fc.array(fc.boolean(), { maxLength: 14 });

describe('Property 3 - account lockout triggers exactly at the threshold within the window', () => {
  it(
    '(1) locks on exactly the 5th failure and never before, freezing the counter once locked (2.7)',
    async () => {
      await fc.assert(
        fc.asyncProperty(failureCount, async (n) => {
          const { deps, redis, store } = makeHarness();

          // Reference model of the sliding-window failure count and lock state.
          let modelFailures = 0;
          let modelLocked = false;

          for (let i = 0; i < n; i += 1) {
            const result = await attempt(deps, /* wrong */ true);

            // Every wrong attempt fails with the uniform generic error.
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toEqual(genericAuthError());

            if (!modelLocked) {
              modelFailures += 1;
              if (modelFailures >= LOCKOUT_THRESHOLD) modelLocked = true;
            }

            // The account is locked iff the model says so: not before the 5th
            // failure, and exactly from it onward.
            expect(await redis.isAccountLocked(USER_ID)).toBe(modelLocked);
            // The counter tracks failures until the lock, then stops growing
            // (a locked account short-circuits before incrementing).
            expect(await redis.getFailedLogins(USER_ID)).toBe(modelFailures);
          }

          // Window TTLs realize the "within a 15-minute window" / "locked for 15
          // minutes" durations of Requirement 2.7.
          if (n >= 1) {
            expect(store.ttls.get(loginFailKey(USER_ID))).toBe(LOGIN_FAIL_WINDOW_SECONDS);
          }
          if (modelLocked) {
            expect(store.ttls.get(lockoutKey(USER_ID))).toBe(LOCKOUT_TTL_SECONDS);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    '(2) once locked, stays locked and rejects even correct credentials without consuming failures (2.7)',
    async () => {
      await fc.assert(
        fc.asyncProperty(attemptTimeline, async (timeline) => {
          const { deps, redis } = makeHarness();

          // Drive exactly the threshold of failures to lock the account.
          for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
            await attempt(deps, /* wrong */ true);
          }
          expect(await redis.isAccountLocked(USER_ID)).toBe(true);
          const lockedCount = await redis.getFailedLogins(USER_ID);
          expect(lockedCount).toBe(LOCKOUT_THRESHOLD);

          // Any subsequent attempts — including ones with the CORRECT password —
          // are rejected with the generic error and never touch the counter.
          for (const wrong of timeline) {
            const result = await attempt(deps, wrong);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toEqual(genericAuthError());
            expect(await redis.isAccountLocked(USER_ID)).toBe(true);
            expect(await redis.getFailedLogins(USER_ID)).toBe(lockedCount);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    '(3) locked iff >= 5 failures in the window; a successful login clears the window (2.7)',
    async () => {
      await fc.assert(
        fc.asyncProperty(attemptTimeline, async (timeline) => {
          const { deps, redis } = makeHarness();

          // Reference model: a success resets the consecutive-failure counter,
          // so lockout requires 5 failures with no intervening success.
          let modelFailures = 0;
          let modelLocked = false;

          for (const wrong of timeline) {
            const result = await attempt(deps, wrong);

            if (modelLocked) {
              // Locked: every attempt is rejected, state is frozen.
              expect(result.ok).toBe(false);
            } else if (wrong) {
              expect(result.ok).toBe(false);
              modelFailures += 1;
              if (modelFailures >= LOCKOUT_THRESHOLD) modelLocked = true;
            } else {
              // Correct password while unlocked: succeeds and clears the window.
              expect(result.ok).toBe(true);
              modelFailures = 0;
            }

            expect(await redis.isAccountLocked(USER_ID)).toBe(modelLocked);
            expect(await redis.getFailedLogins(USER_ID)).toBe(modelFailures);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );
});

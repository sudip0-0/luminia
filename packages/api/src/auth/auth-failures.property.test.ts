// Feature: lumina, Property 2: Authentication failures are indistinguishable
//
// Property-based coverage for the Auth_Service guarantee that every
// authentication failure of a given class returns a byte-for-byte identical
// error response, revealing nothing about which factor failed or whether the
// account exists (Requirements 2.2, 2.4, 2.6).
//
// Property 2 (design.md): *For any* failed authentication — an unknown email, a
// known email with a wrong password, an expired/malformed/invalidated refresh
// token, or a missing/invalid access token on a protected route — the returned
// error body and status code are identical to those of every other failure of
// its class.
//
// Three sub-properties are exercised, each across generated inputs at a minimum
// of 100 iterations and observed only through the public API + recorded side
// effects (no implementation file is modified):
//
//   (1) login — for any unknown email OR any known-email/wrong-password OR any
//       OAuth-only (null password hash) failure, `login` returns
//       `{ ok: false, error }` where `error` deep-equals `genericAuthError()`;
//       all such envelopes are mutually identical (Requirement 2.2).
//   (2) refresh — for any unknown, malformed, revoked, or expired refresh token,
//       `refresh` returns `{ ok: false, error }` where `error` deep-equals
//       `genericAuthError()`; all such envelopes are mutually identical
//       (Requirement 2.4).
//   (3) access-token guard — for any missing, malformed, expired, or denylisted
//       access token on a protected route, the guard responds with status 401
//       and a body deep-equal to `authorizationError()`; the status+envelope are
//       identical across every failure (Requirement 2.6).
//
// All external state (PostgreSQL, Redis) is supplied via in-memory fakes — a
// SQL-dispatching FakeQueryable and an in-memory RedisLike wrapped in the real
// RedisKeyStore — mirroring the patterns in session.test.ts / middleware.test.ts.
//
// Validates: Requirements 2.2, 2.4, 2.6

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import {
  FakeQueryable,
  normalizeSql,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import { RedisKeyStore, type RedisLike } from '../redis/client.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TEST_DEFAULT_ACCESS_TOKEN_SECRET,
} from './config.js';
import { hashPassword } from './passwords.js';
import { hashRefreshToken } from './hash.js';
import { genericAuthError, login, refresh, type LoginDeps } from './session.js';
import {
  authorizationError,
  issueAccessToken,
  type AccessTokenDenylist,
} from './tokens.js';
import { makeAccessTokenGuard } from './middleware.js';

// `login` runs a real (deliberately slow) bcrypt comparison on every attempt,
// so the login property uses the 100-iteration minimum; the bcrypt-free refresh
// and guard properties run more.
const LOGIN_RUNS = { numRuns: 100 } as const;
const RUNS = { numRuns: 200 } as const;

// Each bcrypt comparison takes ~100-200ms, so the 100-iteration login
// properties need a generous per-test timeout well above Vitest's 5s default.
const LOGIN_TIMEOUT_MS = 60_000;

const SECRET = TEST_DEFAULT_ACCESS_TOKEN_SECRET;
const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;
const tokenOptions = { secret: SECRET, now: clock };

const KNOWN_EMAIL = 'reader@example.com';
const KNOWN_PASSWORD = 'a-correct-horse-battery';

/** A real bcrypt hash of {@link KNOWN_PASSWORD}, computed once for the suite. */
let KNOWN_PASSWORD_HASH: string;
beforeAll(async () => {
  KNOWN_PASSWORD_HASH = await hashPassword(KNOWN_PASSWORD);
});

// --- In-memory Redis (mirrors session.test.ts) -----------------------------

/** Minimal in-memory {@link RedisLike} so lockout/denylist use the real store. */
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

/** In-memory {@link AccessTokenDenylist} recording denied `jti`s. */
class FakeDenylist implements AccessTokenDenylist {
  readonly denied = new Set<string>();
  async denyAccessToken(jti: string): Promise<void> {
    this.denied.add(jti);
  }
  async isAccessTokenDenied(jti: string): Promise<boolean> {
    return this.denied.has(jti);
  }
}

// --- SQL-dispatching fakes (mirror session.test.ts) ------------------------

/** A canned `user` row matching the columns the users repository selects. */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-1',
    email: KNOWN_EMAIL,
    password_hash: KNOWN_PASSWORD_HASH,
    display_name: 'reader',
    avatar_url: null,
    depth_preference: 'balanced',
    daily_goal_minutes: 15,
    push_enabled: false,
    onboarding_completed_at: null,
    created_at: new Date(FIXED_NOW),
    ...overrides,
  };
}

/** A canned `refresh_token` row (for find-by-hash). */
function refreshRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rt-1',
    user_id: 'u-1',
    token_hash: '__hash__',
    expires_at: new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000),
    revoked_at: null,
    created_at: new Date(FIXED_NOW),
    ...overrides,
  };
}

interface FakeRows {
  userByEmail?: Record<string, unknown> | null;
  refreshByHash?: Record<string, unknown> | null;
}

/** A {@link FakeQueryable} dispatching on SQL for the auth flows. */
function fakeDb(rows: FakeRows = {}): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM "user" WHERE email')) {
      return { rows: rows.userByEmail ? [rows.userByEmail] : [] };
    }
    if (s.includes('INSERT INTO refresh_token')) {
      return { rows: [refreshRow()] };
    }
    if (s.includes('FROM refresh_token WHERE token_hash')) {
      return { rows: rows.refreshByHash ? [rows.refreshByHash] : [] };
    }
    return { rows: [] };
  });
}

/** Build a fresh login deps bundle backed by a SQL fake and the real store. */
function loginDeps(rows: FakeRows = {}): LoginDeps {
  return { db: fakeDb(rows), redis: new RedisKeyStore(new InMemoryRedis()), tokenOptions };
}

// --- Generators ------------------------------------------------------------

/** Varied, mostly email-shaped strings (also includes a few odd shapes). */
const emailArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.constantFrom('example.com', 'mail.test', 'lumina.io', 'foo.bar.org'),
    )
    .map(([local, domain]) => `${local}@${domain}`),
  fc.string({ maxLength: 40 }),
);

/** Varied password strings (any non-empty content). */
const passwordArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 64 });

/** Varied opaque token strings (refresh and access tokens alike). */
const tokenArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.hexaString({ minLength: 1, maxLength: 80 }),
  fc.constant(''),
);

/**
 * A single login-failure scenario. Each carries everything needed to build a
 * fresh `login` call that must fail with the generic error.
 */
type LoginFailure =
  | { kind: 'unknown-email'; email: string; password: string }
  | { kind: 'wrong-password'; password: string }
  | { kind: 'oauth-only'; password: string };

const loginFailureArb: fc.Arbitrary<LoginFailure> = fc.oneof(
  fc.record({
    kind: fc.constant('unknown-email' as const),
    email: emailArb,
    password: passwordArb,
  }),
  // Known account, wrong password — exclude the (vanishingly unlikely) case
  // where the generated password equals the real one.
  fc.record({
    kind: fc.constant('wrong-password' as const),
    password: passwordArb.filter((p) => p !== KNOWN_PASSWORD),
  }),
  // Known account that is OAuth-only (null hash): no password can ever match.
  fc.record({
    kind: fc.constant('oauth-only' as const),
    password: passwordArb,
  }),
);

/** Run one login-failure scenario and return its result. */
async function runLoginFailure(scenario: LoginFailure) {
  if (scenario.kind === 'unknown-email') {
    return login(loginDeps({ userByEmail: null }), {
      email: scenario.email,
      password: scenario.password,
    });
  }
  if (scenario.kind === 'wrong-password') {
    return login(loginDeps({ userByEmail: userRow() }), {
      email: KNOWN_EMAIL,
      password: scenario.password,
    });
  }
  // oauth-only
  return login(loginDeps({ userByEmail: userRow({ password_hash: null }) }), {
    email: KNOWN_EMAIL,
    password: scenario.password,
  });
}

/** A single refresh-failure scenario over a generated token string. */
type RefreshFailure =
  | { kind: 'unknown'; token: string }
  | { kind: 'revoked'; token: string }
  | { kind: 'expired'; token: string };

const refreshFailureArb: fc.Arbitrary<RefreshFailure> = fc.oneof(
  // Unknown / malformed: the hash matches no stored row.
  fc.record({ kind: fc.constant('unknown' as const), token: tokenArb }),
  fc.record({ kind: fc.constant('revoked' as const), token: tokenArb }),
  fc.record({ kind: fc.constant('expired' as const), token: tokenArb }),
);

/** Run one refresh-failure scenario and return its result. */
async function runRefreshFailure(scenario: RefreshFailure) {
  let rows: FakeRows;
  if (scenario.kind === 'unknown') {
    rows = { refreshByHash: null };
  } else if (scenario.kind === 'revoked') {
    rows = {
      refreshByHash: refreshRow({
        token_hash: hashRefreshToken(scenario.token),
        revoked_at: new Date(FIXED_NOW - 1000),
      }),
    };
  } else {
    rows = {
      refreshByHash: refreshRow({
        token_hash: hashRefreshToken(scenario.token),
        expires_at: new Date(FIXED_NOW - 1000),
      }),
    };
  }
  return refresh({ db: fakeDb(rows), tokenOptions }, { refreshToken: scenario.token });
}

// --- Minimal Fastify request/reply doubles (mirror middleware.test.ts) -----

function fakeReply() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    async send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function fakeRequest(authorization?: string) {
  return {
    headers: authorization ? { authorization } : ({} as Record<string, string>),
    auth: undefined as unknown,
  };
}

/** A single protected-route access-token failure scenario. */
type AccessFailure =
  | { kind: 'missing' }
  | { kind: 'malformed'; token: string }
  | { kind: 'expired' }
  | { kind: 'denylisted' };

const accessFailureArb: fc.Arbitrary<AccessFailure> = fc.oneof(
  fc.constant({ kind: 'missing' as const }),
  fc.record({ kind: fc.constant('malformed' as const), token: tokenArb }),
  fc.constant({ kind: 'expired' as const }),
  fc.constant({ kind: 'denylisted' as const }),
);

/** Run one access-token guard failure scenario and return the reply double. */
async function runAccessFailure(scenario: AccessFailure) {
  const denylist = new FakeDenylist();

  let header: string | undefined;
  let guardClock = clock;

  if (scenario.kind === 'missing') {
    header = undefined;
  } else if (scenario.kind === 'malformed') {
    header = `Bearer ${scenario.token}`;
  } else if (scenario.kind === 'expired') {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    header = `Bearer ${issued.token}`;
    guardClock = () => FIXED_NOW + (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000;
  } else {
    // denylisted
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    await denylist.denyAccessToken(issued.jti);
    header = `Bearer ${issued.token}`;
  }

  const guard = makeAccessTokenGuard({ denylist, secret: SECRET, now: guardClock });
  const req = fakeRequest(header);
  const reply = fakeReply();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await guard(req as any, reply as any);
  return { req, reply };
}

// --- Properties ------------------------------------------------------------

describe('Property 2 - authentication failures are indistinguishable', () => {
  it('(1) login: every unknown-email / wrong-password / oauth-only failure returns the identical generic error (Req 2.2)', async () => {
    const reference = genericAuthError();
    await fc.assert(
      fc.asyncProperty(loginFailureArb, async (scenario) => {
        const result = await runLoginFailure(scenario);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // Byte-for-byte identical to the single generic auth error envelope.
        expect(result.error).toEqual(reference);
        // And it carries no hint of which factor failed (only code + message).
        expect(Object.keys(result.error.error).sort()).toEqual(['code', 'message']);
      }),
      LOGIN_RUNS,
    );
  }, LOGIN_TIMEOUT_MS);

  it('(1b) login: an unknown-email failure and a wrong-password failure are mutually identical (Req 2.2)', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, passwordArb, passwordArb, async (email, p1, p2) => {
        const unknown = await runLoginFailure({ kind: 'unknown-email', email, password: p1 });
        const wrong = await runLoginFailure({
          kind: 'wrong-password',
          password: p2 === KNOWN_PASSWORD ? `${p2}!` : p2,
        });
        expect(unknown.ok).toBe(false);
        expect(wrong.ok).toBe(false);
        if (unknown.ok || wrong.ok) return;
        expect(unknown.error).toEqual(wrong.error);
        expect(unknown.error).toEqual(genericAuthError());
      }),
      LOGIN_RUNS,
    );
  }, LOGIN_TIMEOUT_MS);

  it('(2) refresh: every unknown / malformed / revoked / expired token returns the identical generic error (Req 2.4)', async () => {
    const reference = genericAuthError();
    await fc.assert(
      fc.asyncProperty(refreshFailureArb, async (scenario) => {
        const result = await runRefreshFailure(scenario);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual(reference);
        expect(Object.keys(result.error.error).sort()).toEqual(['code', 'message']);
      }),
      RUNS,
    );
  });

  it('(2b) refresh: the login generic error and the refresh generic error are the same envelope (Reqs 2.2, 2.4)', async () => {
    await fc.assert(
      fc.asyncProperty(refreshFailureArb, async (scenario) => {
        const result = await runRefreshFailure(scenario);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // login and refresh share one indistinguishable failure envelope.
        expect(result.error).toEqual(genericAuthError());
      }),
      RUNS,
    );
  });

  it('(3) protected route: every missing / malformed / expired / denylisted access token yields status 401 + the identical authorization error (Req 2.6)', async () => {
    const reference = authorizationError();
    await fc.assert(
      fc.asyncProperty(accessFailureArb, async (scenario) => {
        const { req, reply } = await runAccessFailure(scenario);
        // Identical status across every failure class.
        expect(reply.statusCode).toBe(401);
        // Byte-for-byte identical envelope; no claims leaked onto the request.
        expect(reply.body).toEqual(reference);
        expect(req.auth).toBeUndefined();
      }),
      RUNS,
    );
  });

  it('(3b) protected route: the rejection envelope is independent of the failure class (Req 2.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accessFailureArb, { minLength: 2, maxLength: 8 }),
        async (scenarios) => {
          const bodies: unknown[] = [];
          const statuses: number[] = [];
          for (const scenario of scenarios) {
            const { reply } = await runAccessFailure(scenario);
            bodies.push(reply.body);
            statuses.push(reply.statusCode);
          }
          // Every observed rejection is identical to the first.
          for (const body of bodies) expect(body).toEqual(bodies[0]);
          for (const status of statuses) expect(status).toBe(401);
          expect(bodies[0]).toEqual(authorizationError());
        },
      ),
      RUNS,
    );
  });
});

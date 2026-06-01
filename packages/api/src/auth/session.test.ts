import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { ERROR_CODES } from '@lumina/shared';
import {
  FakeQueryable,
  normalizeSql,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import { RedisKeyStore, type RedisLike } from '../redis/client.js';
import { lockoutKey, loginFailKey } from '../redis/keys.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TEST_DEFAULT_ACCESS_TOKEN_SECRET,
} from './config.js';
import { hashRefreshToken } from './hash.js';
import { hashPassword } from './passwords.js';
import {
  LOCKOUT_THRESHOLD,
  genericAuthError,
  login,
  logout,
  refresh,
  type LoginDeps,
} from './session.js';

// Verifies login, refresh, logout, and account lockout (Requirement 2)
// end-to-end over a SQL-dispatching FakeQueryable and an in-memory fake Redis
// wrapped in the real RedisKeyStore — no live database or Redis. Covers:
// token issuance + counter clear on valid login (2.1), indistinguishable
// generic error for unknown email and wrong password (2.2), lockout at 5
// failures within the window rejecting even valid credentials (2.7), access
// token refresh (2.3), generic error for expired/revoked/malformed refresh
// (2.4), and logout denylisting the access jti while revoking the refresh
// token (2.5).

const SECRET = TEST_DEFAULT_ACCESS_TOKEN_SECRET;
const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;
const tokenOptions = { secret: SECRET, now: clock };

const EMAIL = 'reader@example.com';
const PASSWORD = 'a-good-password';

/** A real bcrypt hash of {@link PASSWORD}, computed once for the suite. */
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await hashPassword(PASSWORD);
});

/**
 * Minimal in-memory {@link RedisLike} (mirrors the redis client tests) so the
 * lockout/denylist behaviour is exercised through the real {@link RedisKeyStore}
 * rather than a hand-rolled stub.
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
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-1',
    email: EMAIL,
    password_hash: PASSWORD_HASH,
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

/** A canned `refresh_token` row (for find-by-hash / issuance). */
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

/** Configurable rows for the SQL-dispatching fake. */
interface FakeRows {
  /** Row returned by `findUserByEmail` (null => no account). */
  userByEmail?: Record<string, unknown> | null;
  /** Row returned by `findRefreshTokenByHash` (null => unknown token). */
  refreshByHash?: Record<string, unknown> | null;
}

/**
 * A {@link FakeQueryable} dispatching on SQL so the auth flows can issue several
 * queries in any order, recording `(sql, params)` for assertions.
 */
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
    if (s.includes('UPDATE refresh_token')) {
      // revoke single / revoke-all both return the affected row(s).
      return { rows: [refreshRow({ revoked_at: new Date(FIXED_NOW) })] };
    }
    return { rows: [] };
  });
}

/** A fresh login deps bundle backed by a SQL fake and the real RedisKeyStore. */
function loginDeps(rows: FakeRows = {}): {
  deps: LoginDeps;
  db: FakeQueryable;
  redis: RedisKeyStore;
  store: InMemoryRedis;
} {
  const db = fakeDb(rows);
  const store = new InMemoryRedis();
  const redis = new RedisKeyStore(store);
  return { deps: { db, redis, tokenOptions }, db, redis, store };
}

describe('login', () => {
  it('issues a 15m access + 30d refresh token and clears the counter on valid credentials (2.1)', async () => {
    const { deps, db, redis, store } = loginDeps({ userByEmail: userRow() });
    // Seed a couple of prior failures to prove a success clears them.
    await redis.incrementFailedLogins('u-1');
    await redis.incrementFailedLogins('u-1');

    const result = await login(deps, { email: EMAIL, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { session } = result;
    expect(session.userId).toBe('u-1');

    // Access token is a valid 15-minute JWT for the user.
    const decoded = jwt.verify(session.accessToken, SECRET, {
      clockTimestamp: Math.floor(FIXED_NOW / 1000),
    }) as jwt.JwtPayload;
    expect(decoded.sub).toBe('u-1');
    expect(decoded.exp).toBe(Math.floor(FIXED_NOW / 1000) + ACCESS_TOKEN_TTL_SECONDS);

    // Refresh token persisted as a hash with a 30-day expiry.
    const refreshInsert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO refresh_token'),
    );
    expect(refreshInsert).toBeDefined();
    const [userId, tokenHash, expiresAt] = refreshInsert!.params as string[];
    expect(userId).toBe('u-1');
    expect(tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(expiresAt).toBe(
      new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    );

    // The failed-login counter was cleared.
    expect(await redis.getFailedLogins('u-1')).toBe(0);
    expect(store.strings.has(loginFailKey('u-1'))).toBe(false);
  });

  it('returns the identical generic error for an unknown email and a wrong password (2.2)', async () => {
    const unknown = loginDeps({ userByEmail: null });
    const wrong = loginDeps({ userByEmail: userRow() });

    const unknownResult = await login(unknown.deps, {
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    const wrongResult = await login(wrong.deps, {
      email: EMAIL,
      password: 'the-wrong-password',
    });

    expect(unknownResult.ok).toBe(false);
    expect(wrongResult.ok).toBe(false);
    if (unknownResult.ok || wrongResult.ok) return;

    // Byte-for-byte identical envelopes, both the generic AUTH_FAILED error.
    expect(unknownResult.error).toEqual(genericAuthError());
    expect(wrongResult.error).toEqual(unknownResult.error);
    expect(unknownResult.error.error.code).toBe(ERROR_CODES.AUTH_FAILED);
  });

  it('does not touch the failure counter for an unknown email (2.2/2.7)', async () => {
    const { deps, store } = loginDeps({ userByEmail: null });
    await login(deps, { email: 'nobody@example.com', password: PASSWORD });
    // No account => no counter key created.
    expect([...store.strings.keys()].some((k) => k.startsWith('login:fail'))).toBe(false);
  });

  it('rejects an OAuth-only account (null password hash) with the generic error (2.2)', async () => {
    const { deps } = loginDeps({ userByEmail: userRow({ password_hash: null }) });
    const result = await login(deps, { email: EMAIL, password: PASSWORD });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(genericAuthError());
  });

  it('locks the account for 15 minutes after 5 failures and rejects even valid credentials (2.7)', async () => {
    const { deps, redis, store } = loginDeps({ userByEmail: userRow() });

    // Five consecutive wrong-password attempts.
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      const r = await login(deps, { email: EMAIL, password: 'nope' });
      expect(r.ok).toBe(false);
    }

    // The account is now locked for 15 minutes (900s TTL).
    expect(await redis.isAccountLocked('u-1')).toBe(true);
    expect(store.ttls.get(lockoutKey('u-1'))).toBe(900);

    // A subsequent attempt with the CORRECT password is still rejected.
    const blocked = await login(deps, { email: EMAIL, password: PASSWORD });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error).toEqual(genericAuthError());
  });

  it('does not lock before the threshold is reached (2.7)', async () => {
    const { deps, redis } = loginDeps({ userByEmail: userRow() });
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      await login(deps, { email: EMAIL, password: 'nope' });
    }
    expect(await redis.isAccountLocked('u-1')).toBe(false);
    // The fourth failure leaves the counter at 4.
    expect(await redis.getFailedLogins('u-1')).toBe(LOCKOUT_THRESHOLD - 1);
  });

  it('does not consume a failure attempt while already locked (2.7)', async () => {
    const { deps, redis } = loginDeps({ userByEmail: userRow() });
    await redis.lockAccount('u-1');
    const before = await redis.getFailedLogins('u-1');
    const result = await login(deps, { email: EMAIL, password: 'nope' });
    expect(result.ok).toBe(false);
    expect(await redis.getFailedLogins('u-1')).toBe(before);
  });
});

describe('refresh', () => {
  it('issues a new 15-minute access token for a valid, non-expired, non-revoked token (2.3)', async () => {
    const rawToken = 'raw-refresh-token-value';
    const db = fakeDb({
      refreshByHash: refreshRow({
        user_id: 'u-7',
        token_hash: hashRefreshToken(rawToken),
      }),
    });

    const result = await refresh({ db, tokenOptions }, { refreshToken: rawToken });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = jwt.verify(result.accessToken, SECRET, {
      clockTimestamp: Math.floor(FIXED_NOW / 1000),
    }) as jwt.JwtPayload;
    expect(decoded.sub).toBe('u-7');
    expect(result.accessTokenExpiresAt).toBe(
      Math.floor(FIXED_NOW / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    );
  });

  it('rejects an unknown/malformed token with the generic error (2.4)', async () => {
    const db = fakeDb({ refreshByHash: null });
    const result = await refresh({ db, tokenOptions }, { refreshToken: 'not-a-real-token' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(genericAuthError());
  });

  it('rejects a revoked refresh token with the generic error (2.4)', async () => {
    const rawToken = 'revoked-token';
    const db = fakeDb({
      refreshByHash: refreshRow({
        token_hash: hashRefreshToken(rawToken),
        revoked_at: new Date(FIXED_NOW - 1000),
      }),
    });
    const result = await refresh({ db, tokenOptions }, { refreshToken: rawToken });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(genericAuthError());
  });

  it('rejects an expired refresh token with the generic error (2.4)', async () => {
    const rawToken = 'expired-token';
    const db = fakeDb({
      refreshByHash: refreshRow({
        token_hash: hashRefreshToken(rawToken),
        expires_at: new Date(FIXED_NOW - 1000),
      }),
    });
    const result = await refresh({ db, tokenOptions }, { refreshToken: rawToken });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual(genericAuthError());
  });
});

describe('logout', () => {
  it('denylists the access jti and revokes the supplied refresh token (2.5)', async () => {
    const db = fakeDb();
    const store = new InMemoryRedis();
    const redis = new RedisKeyStore(store);
    const rawRefresh = 'session-refresh-token';
    const exp = Math.floor(FIXED_NOW / 1000) + ACCESS_TOKEN_TTL_SECONDS;

    await logout(
      { db, redis, now: clock },
      {
        accessTokenClaims: { userId: 'u-1', jti: 'jti-123', exp },
        refreshToken: rawRefresh,
      },
    );

    // Access jti is denylisted so any later request presenting it is rejected.
    expect(await redis.isAccessTokenDenied('jti-123')).toBe(true);

    // The specific refresh token row was revoked by its hash.
    const revoke = db.calls.find((c) => {
      const s = normalizeSql(c.sql);
      return s.includes('UPDATE refresh_token') && s.includes('token_hash');
    });
    expect(revoke).toBeDefined();
    expect((revoke!.params as unknown[])[0]).toBe(hashRefreshToken(rawRefresh));
  });

  it('revokes every active refresh token for the user when none is supplied (2.5)', async () => {
    const db = fakeDb();
    const store = new InMemoryRedis();
    const redis = new RedisKeyStore(store);
    const exp = Math.floor(FIXED_NOW / 1000) + ACCESS_TOKEN_TTL_SECONDS;

    await logout(
      { db, redis, now: clock },
      { accessTokenClaims: { userId: 'u-1', jti: 'jti-456', exp } },
    );

    expect(await redis.isAccessTokenDenied('jti-456')).toBe(true);
    const revokeAll = db.calls.find((c) => {
      const s = normalizeSql(c.sql);
      return s.includes('UPDATE refresh_token') && s.includes('user_id');
    });
    expect(revokeAll).toBeDefined();
    expect((revokeAll!.params as unknown[])[0]).toBe('u-1');
  });
});

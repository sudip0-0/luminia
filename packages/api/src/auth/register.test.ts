import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { ERROR_CODES } from '@lumina/shared';
import {
  FakeQueryable,
  normalizeSql,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TEST_DEFAULT_ACCESS_TOKEN_SECRET,
} from './config.js';
import { hashRefreshToken } from './hash.js';
import { verifyPassword } from './passwords.js';
import {
  register,
  registerOAuth,
  type OAuthVerifier,
  type RegisterOAuthDeps,
  type VerifiedOAuthIdentity,
} from './register.js';
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  DEFAULT_DEPTH_PREFERENCE,
} from '../repositories/users.repository.js';

// Verifies registration and OAuth registration (Requirement 1) end-to-end over
// a SQL-dispatching FakeQueryable and a fake OAuth verifier — no live database
// or provider. Covers: account creation + token issuance (1.1), duplicate
// email conflict (1.2), email/password/goal validation (1.3, 1.4, 1.7, 1.8),
// goal/depth defaulting (1.9), and the OAuth link-vs-create branches plus
// unsupported/unverifiable rejection (1.5, 1.6).

const SECRET = TEST_DEFAULT_ACCESS_TOKEN_SECRET;
const FIXED_NOW = 1_700_000_000_000;
const clock = (): number => FIXED_NOW;
const tokenOptions = { secret: SECRET, now: clock };

/** A canned `user` row matching the columns the users repository selects. */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-1',
    email: 'reader@example.com',
    password_hash: 'stored-hash',
    display_name: 'reader',
    avatar_url: null,
    depth_preference: DEFAULT_DEPTH_PREFERENCE,
    daily_goal_minutes: DEFAULT_DAILY_GOAL_MINUTES,
    push_enabled: false,
    onboarding_completed_at: null,
    created_at: new Date(FIXED_NOW),
    ...overrides,
  };
}

/** A canned `oauth_identity` row. */
function oauthRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'oa-1',
    user_id: 'u-1',
    provider: 'google',
    provider_user_id: 'g-123',
    email: 'reader@example.com',
    created_at: new Date(FIXED_NOW),
    ...overrides,
  };
}

/** A canned `refresh_token` row. */
function refreshRow(): Record<string, unknown> {
  return {
    id: 'rt-1',
    user_id: 'u-1',
    token_hash: '__hash__',
    expires_at: new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000),
    revoked_at: null,
    created_at: new Date(FIXED_NOW),
  };
}

/** Configurable rows for the SQL-dispatching fake. */
interface FakeRows {
  /** Row returned by `findUserByEmail` (null => no existing account). */
  userByEmail?: Record<string, unknown> | null;
  /** Row returned by `INSERT INTO "user"`. */
  createdUser?: Record<string, unknown>;
  /** Row returned by `findOAuthIdentity` (null => not linked). */
  oauthIdentity?: Record<string, unknown> | null;
  /** Row returned by `INSERT INTO oauth_identity`. */
  linkedIdentity?: Record<string, unknown>;
}

/**
 * A {@link FakeQueryable} that dispatches on the SQL it receives so the
 * registration flows can issue several queries in any order. Each query records
 * its `(sql, params)` for assertions.
 */
function fakeDb(rows: FakeRows = {}): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('INSERT INTO "user"')) {
      return { rows: [rows.createdUser ?? userRow()] };
    }
    if (s.includes('FROM "user" WHERE email')) {
      const row = rows.userByEmail;
      return { rows: row ? [row] : [] };
    }
    if (s.includes('FROM "user" WHERE id')) {
      return { rows: rows.userByEmail ? [rows.userByEmail] : [] };
    }
    if (s.includes('INSERT INTO oauth_identity')) {
      return { rows: [rows.linkedIdentity ?? oauthRow()] };
    }
    if (s.includes('FROM oauth_identity')) {
      const row = rows.oauthIdentity;
      return { rows: row ? [row] : [] };
    }
    if (s.includes('INSERT INTO refresh_token')) {
      return { rows: [refreshRow()] };
    }
    return { rows: [] };
  });
}

/** Build an OAuth verifier that resolves the given identity (or null). */
function fakeVerifier(
  identity: VerifiedOAuthIdentity | null,
): OAuthVerifier {
  return {
    async verify(): Promise<VerifiedOAuthIdentity | null> {
      return identity;
    },
  };
}

describe('register', () => {
  it('creates an account and issues access + refresh tokens (1.1)', async () => {
    const db = fakeDb({ userByEmail: null, createdUser: userRow() });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { session } = result;
    expect(session.userId).toBe('u-1');

    // Access token is a valid 15-minute JWT for the new user.
    const decoded = jwt.verify(session.accessToken, SECRET, {
      clockTimestamp: Math.floor(FIXED_NOW / 1000),
    }) as jwt.JwtPayload;
    expect(decoded.sub).toBe('u-1');
    expect(decoded.exp).toBe(Math.floor(FIXED_NOW / 1000) + ACCESS_TOKEN_TTL_SECONDS);

    // Refresh token is opaque, stored only as a hash, with a 30-day expiry.
    const refreshInsert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO refresh_token'),
    );
    expect(refreshInsert).toBeDefined();
    const [userId, tokenHash, expiresAt] = refreshInsert!.params as string[];
    expect(userId).toBe('u-1');
    expect(tokenHash).toBe(hashRefreshToken(session.refreshToken));
    expect(tokenHash).not.toBe(session.refreshToken);
    expect(expiresAt).toBe(
      new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    );
  });

  it('stores the password as a verifiable bcrypt hash, never plaintext (1.1)', async () => {
    const db = fakeDb({ userByEmail: null });
    const password = 'plaintext-password-1';
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password,
    });
    expect(result.ok).toBe(true);

    const insert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO "user"'),
    );
    // password_hash is the 2nd INSERT param (after email).
    const passwordHash = (insert!.params as unknown[])[1] as string;
    expect(passwordHash).not.toBe(password);
    expect(passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword(password, passwordHash)).toBe(true);
  });

  it('applies the default Daily_Goal (15) and Depth_Preference (balanced) when omitted (1.9)', async () => {
    const db = fakeDb({ userByEmail: null });
    await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
    });

    const insert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO "user"'),
    );
    const params = insert!.params as unknown[];
    // params: [email, password_hash, display_name, avatar_url, depth, goal, push]
    expect(params[4]).toBe(DEFAULT_DEPTH_PREFERENCE);
    expect(params[4]).toBe('balanced');
    expect(params[5]).toBe(DEFAULT_DAILY_GOAL_MINUTES);
    expect(params[5]).toBe(15);
  });

  it('persists a supplied in-range Daily_Goal and Depth_Preference (1.7)', async () => {
    const db = fakeDb({ userByEmail: null });
    await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
      dailyGoal: 90,
      depth: 'deep',
    });

    const insert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO "user"'),
    );
    const params = insert!.params as unknown[];
    expect(params[4]).toBe('deep');
    expect(params[5]).toBe(90);
  });

  it('rejects a duplicate email with a CONFLICT error and creates no account (1.2)', async () => {
    const db = fakeDb({ userByEmail: userRow() });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.CONFLICT);
    // No INSERT was attempted.
    expect(
      db.calls.some((c) => normalizeSql(c.sql).includes('INSERT INTO "user"')),
    ).toBe(false);
  });

  it('maps a concurrent unique-violation on insert to a CONFLICT (1.2)', async () => {
    // userByEmail returns null (no row) but the INSERT throws 23505.
    const db = new FakeQueryable((sql) => {
      const s = normalizeSql(sql);
      if (s.includes('INSERT INTO "user"')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      return { rows: [] };
    });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('rejects an invalid email format with a validation error (1.3)', async () => {
    const db = fakeDb({ userByEmail: null });
    const result = await register({ db, tokenOptions }, {
      email: 'not-an-email',
      password: 'a-good-password',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    // Nothing was queried at all (validation precedes any DB access).
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an over-length email (>254 chars) with a validation error (1.3)', async () => {
    const db = fakeDb({ userByEmail: null });
    const longLocal = 'a'.repeat(250);
    const result = await register({ db, tokenOptions }, {
      email: `${longLocal}@example.com`,
      password: 'a-good-password',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('rejects a too-short password with a validation error (1.4)', async () => {
    const db = fakeDb({ userByEmail: null });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'short',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a too-long password (>128 chars) with a validation error (1.4)', async () => {
    const db = fakeDb({ userByEmail: null });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'p'.repeat(129),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('rejects a Daily_Goal below the range with a validation error (1.8)', async () => {
    const db = fakeDb({ userByEmail: null });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
      dailyGoal: 4,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(result.error.error.details).toMatchObject({ field: 'dailyGoal' });
  });

  it('rejects a Daily_Goal above the range with a validation error (1.8)', async () => {
    const db = fakeDb({ userByEmail: null });
    const result = await register({ db, tokenOptions }, {
      email: 'reader@example.com',
      password: 'a-good-password',
      dailyGoal: 121,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

describe('registerOAuth', () => {
  const identity: VerifiedOAuthIdentity = {
    providerUserId: 'g-123',
    email: 'reader@example.com',
    displayName: 'Ada Reader',
  };

  function oauthDeps(db: FakeQueryable, id: VerifiedOAuthIdentity | null): RegisterOAuthDeps {
    return { db, verifier: fakeVerifier(id), tokenOptions };
  }

  it('reuses the account already linked to the identity (1.5)', async () => {
    const db = fakeDb({ oauthIdentity: oauthRow({ user_id: 'u-1' }) });
    const result = await registerOAuth(oauthDeps(db, identity), {
      provider: 'google',
      providerToken: 'tok',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('existing');
    expect(result.session.userId).toBe('u-1');
    // No new account and no new link were created.
    expect(
      db.calls.some((c) => normalizeSql(c.sql).includes('INSERT INTO "user"')),
    ).toBe(false);
    expect(
      db.calls.some((c) =>
        normalizeSql(c.sql).includes('INSERT INTO oauth_identity'),
      ),
    ).toBe(false);
  });

  it('links the identity to an existing email-matched account (1.5)', async () => {
    const db = fakeDb({
      oauthIdentity: null,
      userByEmail: userRow({ id: 'u-9' }),
    });
    const result = await registerOAuth(oauthDeps(db, identity), {
      provider: 'google',
      providerToken: 'tok',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('linked');
    expect(result.session.userId).toBe('u-9');
    // Linked the identity but did NOT create a new account.
    const link = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO oauth_identity'),
    );
    expect(link).toBeDefined();
    expect((link!.params as unknown[])[0]).toBe('u-9');
    expect(
      db.calls.some((c) => normalizeSql(c.sql).includes('INSERT INTO "user"')),
    ).toBe(false);
  });

  it('creates a new password-less account when no identity or email matches (1.5)', async () => {
    const db = fakeDb({
      oauthIdentity: null,
      userByEmail: null,
      createdUser: userRow({ id: 'u-new', password_hash: null }),
    });
    const result = await registerOAuth(oauthDeps(db, identity), {
      provider: 'apple',
      providerToken: 'tok',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('created');
    expect(result.session.userId).toBe('u-new');

    const insert = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO "user"'),
    );
    expect(insert).toBeDefined();
    const params = insert!.params as unknown[];
    // password_hash (2nd param) is null for an OAuth-only account.
    expect(params[1]).toBeNull();
    // display name falls back to the provider-supplied name.
    expect(params[2]).toBe('Ada Reader');
    // The identity was linked to the freshly created account.
    const link = db.calls.find((c) =>
      normalizeSql(c.sql).includes('INSERT INTO oauth_identity'),
    );
    expect(link).toBeDefined();
    expect((link!.params as unknown[])[0]).toBe('u-new');
  });

  it('rejects an unsupported provider and creates nothing (1.6)', async () => {
    const db = fakeDb({});
    const result = await registerOAuth(oauthDeps(db, identity), {
      provider: 'facebook',
      providerToken: 'tok',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an unverifiable identity (verifier returns null) (1.6)', async () => {
    const db = fakeDb({});
    const result = await registerOAuth(oauthDeps(db, null), {
      provider: 'google',
      providerToken: 'bad-token',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    // No account work happened.
    expect(
      db.calls.some((c) => normalizeSql(c.sql).includes('INSERT INTO "user"')),
    ).toBe(false);
  });

  it('rejects when the verifier throws (1.6)', async () => {
    const db = fakeDb({});
    const throwingVerifier: OAuthVerifier = {
      async verify(): Promise<VerifiedOAuthIdentity | null> {
        throw new Error('provider unreachable');
      },
    };
    const result = await registerOAuth(
      { db, verifier: throwingVerifier, tokenOptions },
      { provider: 'google', providerToken: 'tok' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('rejects a verified identity carrying an invalid email (1.6)', async () => {
    const db = fakeDb({});
    const result = await registerOAuth(
      oauthDeps(db, { providerUserId: 'g-1', email: 'not-an-email' }),
      { provider: 'google', providerToken: 'tok' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { ERROR_CODES } from '@lumina/shared';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  TEST_DEFAULT_ACCESS_TOKEN_SECRET,
} from './config.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenHashEquals,
} from './hash.js';
import {
  authorizationError,
  extractBearerToken,
  issueAccessToken,
  issueRefreshToken,
  revokeAccessToken,
  verifyAccessToken,
  type AccessTokenDenylist,
} from './tokens.js';

/**
 * Minimal in-memory stand-in for the Redis `jti` denylist (the surface
 * {@link RedisKeyStore} exposes), recording the TTL each `jti` was denied with
 * so revocation TTLs can be asserted without a live Redis.
 */
class FakeDenylist implements AccessTokenDenylist {
  readonly denied = new Map<string, number | undefined>();

  async denyAccessToken(jti: string, ttlSeconds?: number): Promise<void> {
    this.denied.set(jti, ttlSeconds);
  }

  async isAccessTokenDenied(jti: string): Promise<boolean> {
    return this.denied.has(jti);
  }
}

const SECRET = TEST_DEFAULT_ACCESS_TOKEN_SECRET;
const FIXED_NOW = 1_700_000_000_000; // fixed epoch ms for deterministic clocks
const clock = () => FIXED_NOW;

/** A FakeQueryable that echoes back the created refresh_token row. */
function refreshTokenDb(): FakeQueryable {
  return new FakeQueryable([
    {
      rows: [
        {
          id: 'rt-1',
          user_id: 'u-1',
          token_hash: '__set_by_assertion__',
          expires_at: new Date(FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000),
          revoked_at: null,
          created_at: new Date(FIXED_NOW),
        },
      ],
    },
  ]);
}

describe('issueAccessToken', () => {
  it('issues a JWT with sub, a unique jti, and a 15-minute expiry', () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const decoded = jwt.verify(issued.token, SECRET, {
      clockTimestamp: Math.floor(FIXED_NOW / 1000),
    }) as jwt.JwtPayload;

    expect(decoded.sub).toBe('u-1');
    expect(decoded.jti).toBe(issued.jti);
    const iat = Math.floor(FIXED_NOW / 1000);
    expect(decoded.iat).toBe(iat);
    expect(decoded.exp).toBe(iat + ACCESS_TOKEN_TTL_SECONDS);
    expect(issued.expiresAt).toBe(iat + ACCESS_TOKEN_TTL_SECONDS);
  });

  it('produces a unique jti per issuance', () => {
    const a = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const b = issueAccessToken('u-1', { secret: SECRET, now: clock });
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });
});

describe('issueRefreshToken', () => {
  it('persists only the hash and returns the raw token (30-day expiry)', async () => {
    const db = refreshTokenDb();
    const issued = await issueRefreshToken(db, 'u-1', { now: clock });

    // Raw token returned to caller; DB received its hash, never the raw value.
    const [userId, tokenHash, expiresAt] = db.lastCall.params as string[];
    expect(userId).toBe('u-1');
    expect(tokenHash).toBe(hashRefreshToken(issued.token));
    expect(tokenHash).not.toBe(issued.token);

    // 30-day expiry persisted as ISO.
    const expectedIso = new Date(
      FIXED_NOW + REFRESH_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    expect(expiresAt).toBe(expectedIso);
    expect(issued.expiresAt).toBe(expectedIso);
    expect(issued.record.userId).toBe('u-1');
  });

  it('generates a distinct raw token each call', async () => {
    const a = await issueRefreshToken(refreshTokenDb(), 'u-1', { now: clock });
    const b = await issueRefreshToken(refreshTokenDb(), 'u-1', { now: clock });
    expect(a.token).not.toBe(b.token);
  });
});

describe('verifyAccessToken', () => {
  let denylist: FakeDenylist;
  beforeEach(() => {
    denylist = new FakeDenylist();
  });

  it('accepts a freshly issued, non-denylisted token', async () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const result = await verifyAccessToken(denylist, issued.token, {
      secret: SECRET,
      now: clock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.userId).toBe('u-1');
      expect(result.claims.jti).toBe(issued.jti);
    }
  });

  it('rejects a missing token', async () => {
    const result = await verifyAccessToken(denylist, undefined, {
      secret: SECRET,
      now: clock,
    });
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a malformed token', async () => {
    const result = await verifyAccessToken(denylist, 'not-a-jwt', {
      secret: SECRET,
      now: clock,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const issued = issueAccessToken('u-1', { secret: 'other-secret', now: clock });
    const result = await verifyAccessToken(denylist, issued.token, {
      secret: SECRET,
      now: clock,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an expired token', async () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const later = () => FIXED_NOW + (ACCESS_TOKEN_TTL_SECONDS + 60) * 1000;
    const result = await verifyAccessToken(denylist, issued.token, {
      secret: SECRET,
      now: later,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a denylisted jti', async () => {
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    await denylist.denyAccessToken(issued.jti);
    const result = await verifyAccessToken(denylist, issued.token, {
      secret: SECRET,
      now: clock,
    });
    expect(result).toEqual({ ok: false, reason: 'denylisted' });
  });
});

describe('revokeAccessToken', () => {
  it('denylists the jti with the remaining lifetime', async () => {
    const denylist = new FakeDenylist();
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    // 5 minutes after issuance: 10 minutes remain.
    const halfway = () => FIXED_NOW + 5 * 60 * 1000;
    await revokeAccessToken(
      denylist,
      { jti: issued.jti, exp: issued.expiresAt },
      { now: halfway },
    );
    expect(denylist.denied.get(issued.jti)).toBe(10 * 60);
  });

  it('is a no-op for an already-expired token', async () => {
    const denylist = new FakeDenylist();
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    const later = () => FIXED_NOW + (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000;
    await revokeAccessToken(
      denylist,
      { jti: issued.jti, exp: issued.expiresAt },
      { now: later },
    );
    expect(denylist.denied.has(issued.jti)).toBe(false);
  });

  it('makes a subsequently revoked token fail verification', async () => {
    const denylist = new FakeDenylist();
    const issued = issueAccessToken('u-1', { secret: SECRET, now: clock });
    await revokeAccessToken(
      denylist,
      { jti: issued.jti, exp: issued.expiresAt },
      { now: clock },
    );
    const result = await verifyAccessToken(denylist, issued.token, {
      secret: SECRET,
      now: clock,
    });
    expect(result).toEqual({ ok: false, reason: 'denylisted' });
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc')).toBe('abc');
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('abc.def')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken(['Bearer a', 'Bearer b'])).toBeNull();
  });
});

describe('authorizationError', () => {
  it('is the uniform generic AUTH_FAILED envelope', () => {
    expect(authorizationError()).toEqual({
      error: { code: ERROR_CODES.AUTH_FAILED, message: 'Authentication required.' },
    });
  });
});

describe('refresh-token hashing', () => {
  it('hashes deterministically and matches in constant time', () => {
    const raw = generateRefreshToken();
    expect(hashRefreshToken(raw)).toBe(hashRefreshToken(raw));
    expect(refreshTokenHashEquals(hashRefreshToken(raw), hashRefreshToken(raw))).toBe(true);
  });

  it('different tokens hash differently', () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });
});

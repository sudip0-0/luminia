import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  FEED_VERSION_TTL_SECONDS,
  LOCKOUT_TTL_SECONDS,
  LOGIN_FAIL_WINDOW_SECONDS,
  NOTIFICATION_TTL_SECONDS,
  denylistKey,
  feedVersionReturnedKey,
  lockoutKey,
  loginFailKey,
  notificationLastKey,
} from './keys.js';

describe('Redis key builders', () => {
  it('builds the denylist key as denylist:jti:{jti}', () => {
    expect(denylistKey('abc123')).toBe('denylist:jti:abc123');
  });

  it('builds the login-fail key as login:fail:{userId}', () => {
    expect(loginFailKey('user-1')).toBe('login:fail:user-1');
  });

  it('builds the lockout key as lockout:{userId}', () => {
    expect(lockoutKey('user-1')).toBe('lockout:user-1');
  });

  it('builds the feed-version returned key as feedver:{feedVersion}:returned', () => {
    expect(feedVersionReturnedKey('v42')).toBe('feedver:v42:returned');
  });

  it('builds the notification key as notif:last:{userId}', () => {
    expect(notificationLastKey('user-1')).toBe('notif:last:user-1');
  });

  // Property: each builder embeds its component verbatim within the documented
  // fixed prefix/suffix, for any non-delimiter-free identifier.
  it('embeds the component within the fixed key shape (property)', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(denylistKey(id)).toBe(`denylist:jti:${id}`);
        expect(loginFailKey(id)).toBe(`login:fail:${id}`);
        expect(lockoutKey(id)).toBe(`lockout:${id}`);
        expect(feedVersionReturnedKey(id)).toBe(`feedver:${id}:returned`);
        expect(notificationLastKey(id)).toBe(`notif:last:${id}`);
      }),
      { numRuns: 100 }
    );
  });

  it('key builders are pure (stable across repeated calls)', () => {
    expect(denylistKey('x')).toBe(denylistKey('x'));
    expect(feedVersionReturnedKey('x')).toBe(feedVersionReturnedKey('x'));
  });
});

describe('Redis TTL constants', () => {
  it('matches the design-specified durations', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900); // 15 min access lifetime
    expect(LOGIN_FAIL_WINDOW_SECONDS).toBe(900); // 15 min sliding window
    expect(LOCKOUT_TTL_SECONDS).toBe(900); // 15 min lockout
    expect(NOTIFICATION_TTL_SECONDS).toBe(86400); // 24 h
    expect(FEED_VERSION_TTL_SECONDS).toBeGreaterThan(0); // feed session TTL
  });
});

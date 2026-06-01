import { describe, it, expect, beforeEach } from 'vitest';
import { RedisKeyStore, type RedisLike } from './client.js';
import {
  denylistKey,
  feedVersionReturnedKey,
  lockoutKey,
  loginFailKey,
  notificationLastKey,
} from './keys.js';

/**
 * Minimal in-memory implementation of {@link RedisLike} used to exercise the
 * typed accessors without a live Redis connection. It records the TTLs passed
 * to `set`/`expire` so tests can assert each accessor applies its key's TTL.
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

describe('RedisKeyStore — denylist:jti', () => {
  let redis: InMemoryRedis;
  let store: RedisKeyStore;
  beforeEach(() => {
    redis = new InMemoryRedis();
    store = new RedisKeyStore(redis);
  });

  it('denies a jti with the default access-token TTL and detects it', async () => {
    await store.denyAccessToken('jti-1');
    expect(await store.isAccessTokenDenied('jti-1')).toBe(true);
    expect(await store.isAccessTokenDenied('jti-2')).toBe(false);
    expect(redis.ttls.get(denylistKey('jti-1'))).toBe(900);
  });

  it('honors a caller-supplied remaining lifetime', async () => {
    await store.denyAccessToken('jti-1', 42);
    expect(redis.ttls.get(denylistKey('jti-1'))).toBe(42);
  });
});

describe('RedisKeyStore — login:fail', () => {
  let redis: InMemoryRedis;
  let store: RedisKeyStore;
  beforeEach(() => {
    redis = new InMemoryRedis();
    store = new RedisKeyStore(redis);
  });

  it('increments and sets the sliding-window TTL only on the first failure', async () => {
    expect(await store.incrementFailedLogins('u1')).toBe(1);
    expect(redis.ttls.get(loginFailKey('u1'))).toBe(900);
    redis.ttls.delete(loginFailKey('u1')); // prove a second incr does not reset it
    expect(await store.incrementFailedLogins('u1')).toBe(2);
    expect(redis.ttls.has(loginFailKey('u1'))).toBe(false);
  });

  it('reads and clears the counter', async () => {
    await store.incrementFailedLogins('u1');
    await store.incrementFailedLogins('u1');
    expect(await store.getFailedLogins('u1')).toBe(2);
    await store.clearFailedLogins('u1');
    expect(await store.getFailedLogins('u1')).toBe(0);
  });
});

describe('RedisKeyStore — lockout', () => {
  it('locks for 15 minutes and reports lock state', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisKeyStore(redis);
    expect(await store.isAccountLocked('u1')).toBe(false);
    await store.lockAccount('u1');
    expect(await store.isAccountLocked('u1')).toBe(true);
    expect(redis.ttls.get(lockoutKey('u1'))).toBe(900);
  });
});

describe('RedisKeyStore — feedver returned set', () => {
  let redis: InMemoryRedis;
  let store: RedisKeyStore;
  beforeEach(() => {
    redis = new InMemoryRedis();
    store = new RedisKeyStore(redis);
  });

  it('records returned ids, refreshes TTL, and dedupes membership', async () => {
    await store.addReturnedArticles('v1', ['a', 'b']);
    await store.addReturnedArticles('v1', ['b', 'c']);
    expect((await store.getReturnedArticles('v1')).sort()).toEqual(['a', 'b', 'c']);
    expect(await store.isArticleReturned('v1', 'a')).toBe(true);
    expect(await store.isArticleReturned('v1', 'z')).toBe(false);
    expect(redis.ttls.get(feedVersionReturnedKey('v1'))).toBe(3600);
  });

  it('is a no-op for an empty id list', async () => {
    await store.addReturnedArticles('v1', []);
    expect(await store.getReturnedArticles('v1')).toEqual([]);
  });
});

describe('RedisKeyStore — notif:last', () => {
  it('stores and reads the last-notification timestamp with a 24h TTL', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisKeyStore(redis);
    expect(await store.getLastNotificationAt('u1')).toBeNull();
    await store.setLastNotificationAt('u1', 1_700_000_000_000);
    expect(await store.getLastNotificationAt('u1')).toBe(1_700_000_000_000);
    expect(redis.ttls.get(notificationLastKey('u1'))).toBe(86400);
  });
});

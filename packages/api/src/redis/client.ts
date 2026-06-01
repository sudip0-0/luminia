// Redis client and typed key accessors.
//
// The API tier is stateless; Redis holds only ephemeral coordination state
// (token denylist, login-fail counter, lockout flag, feed-version returned-set,
// last-notification timestamp). See the "Redis Keys" table in the design.
//
// To keep the typed accessors unit-testable without a live Redis connection,
// they depend on the narrow {@link RedisLike} interface rather than on `ioredis`
// directly. A real connection is wrapped via {@link ioredisAdapter}; tests can
// supply an in-memory implementation of the same interface.

import { Redis, type RedisOptions } from 'ioredis';
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

/**
 * The minimal surface of Redis commands used by the typed accessors. A live
 * `ioredis` connection satisfies this via {@link ioredisAdapter}; tests can
 * provide an in-memory fake. Keeping the surface narrow makes the accessors
 * trivially mockable and keeps the production client a thin pass-through.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** Set a string value, optionally with an expiry expressed in whole seconds. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  exists(key: string): Promise<boolean>;
  del(key: string): Promise<void>;
  sadd(key: string, members: string[]): Promise<void>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<boolean>;
}

/** Creates a live `ioredis` connection. */
export function createRedisConnection(options?: RedisOptions): Redis {
  return new Redis(options ?? {});
}

/**
 * Adapts a live `ioredis` connection to the {@link RedisLike} interface,
 * normalizing command results (e.g. `EXISTS`/`SISMEMBER` integers to booleans).
 */
export function ioredisAdapter(redis: Redis): RedisLike {
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds === undefined) {
        await redis.set(key, value);
      } else {
        await redis.set(key, value, 'EX', ttlSeconds);
      }
    },
    async incr(key) {
      return redis.incr(key);
    },
    async expire(key, ttlSeconds) {
      await redis.expire(key, ttlSeconds);
    },
    async exists(key) {
      return (await redis.exists(key)) > 0;
    },
    async del(key) {
      await redis.del(key);
    },
    async sadd(key, members) {
      if (members.length === 0) return;
      await redis.sadd(key, ...members);
    },
    async smembers(key) {
      return redis.smembers(key);
    },
    async sismember(key, member) {
      return (await redis.sismember(key, member)) === 1;
    },
  };
}

/**
 * Typed accessors over the Lumina Redis keys. Each accessor reads or writes a
 * single logical key (see the "Redis Keys" table) and applies that key's TTL.
 */
export class RedisKeyStore {
  constructor(private readonly client: RedisLike) {}

  // --- denylist:jti:{jti} — revoked access tokens (Requirements 2.5, 2.6) ---

  /**
   * Denylist a revoked access-token `jti`. The TTL defaults to the maximum
   * access-token lifetime; pass the precise remaining lifetime when known so
   * the entry expires exactly when the token would have.
   */
  async denyAccessToken(
    jti: string,
    ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS
  ): Promise<void> {
    await this.client.set(denylistKey(jti), '1', ttlSeconds);
  }

  /** Whether the given access-token `jti` has been revoked. */
  async isAccessTokenDenied(jti: string): Promise<boolean> {
    return this.client.exists(denylistKey(jti));
  }

  // --- login:fail:{userId} — failed-login counter (Requirement 2.7) ---

  /**
   * Increment the failed-login counter, (re)establishing the sliding window TTL
   * on the first failure. Returns the current count within the window.
   */
  async incrementFailedLogins(
    userId: string,
    windowSeconds: number = LOGIN_FAIL_WINDOW_SECONDS
  ): Promise<number> {
    const key = loginFailKey(userId);
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }

  /** Current failed-login count for the user (0 when the window has expired). */
  async getFailedLogins(userId: string): Promise<number> {
    const raw = await this.client.get(loginFailKey(userId));
    return raw === null ? 0 : Number(raw);
  }

  /** Clear the failed-login counter (e.g. after a successful login). */
  async clearFailedLogins(userId: string): Promise<void> {
    await this.client.del(loginFailKey(userId));
  }

  // --- lockout:{userId} — account-lockout flag (Requirement 2.7) ---

  /** Lock the account for the lockout window (default 15 minutes). */
  async lockAccount(
    userId: string,
    ttlSeconds: number = LOCKOUT_TTL_SECONDS
  ): Promise<void> {
    await this.client.set(lockoutKey(userId), '1', ttlSeconds);
  }

  /** Whether the account is currently locked. */
  async isAccountLocked(userId: string): Promise<boolean> {
    return this.client.exists(lockoutKey(userId));
  }

  // --- feedver:{feedVersion}:returned — returned-article set (Requirement 8.2) ---

  /**
   * Record article ids as already returned within a feed version so subsequent
   * cursor pages never repeat them, refreshing the feed-session TTL.
   */
  async addReturnedArticles(
    feedVersion: string,
    articleIds: string[],
    ttlSeconds: number = FEED_VERSION_TTL_SECONDS
  ): Promise<void> {
    if (articleIds.length === 0) return;
    const key = feedVersionReturnedKey(feedVersion);
    await this.client.sadd(key, articleIds);
    await this.client.expire(key, ttlSeconds);
  }

  /** All article ids already returned within the feed version. */
  async getReturnedArticles(feedVersion: string): Promise<string[]> {
    return this.client.smembers(feedVersionReturnedKey(feedVersion));
  }

  /** Whether the article id was already returned within the feed version. */
  async isArticleReturned(
    feedVersion: string,
    articleId: string
  ): Promise<boolean> {
    return this.client.sismember(feedVersionReturnedKey(feedVersion), articleId);
  }

  // --- notif:last:{userId} — last-notification timestamp (Requirement 18.2) ---

  /**
   * Record the timestamp (epoch milliseconds) of the user's last push, with a
   * 24-hour TTL enforcing the rolling rate limit.
   */
  async setLastNotificationAt(
    userId: string,
    timestampMs: number,
    ttlSeconds: number = NOTIFICATION_TTL_SECONDS
  ): Promise<void> {
    await this.client.set(notificationLastKey(userId), String(timestampMs), ttlSeconds);
  }

  /** The user's last push timestamp (epoch ms), or null when none within 24h. */
  async getLastNotificationAt(userId: string): Promise<number | null> {
    const raw = await this.client.get(notificationLastKey(userId));
    return raw === null ? null : Number(raw);
  }
}

/** Build a {@link RedisKeyStore} backed by a live `ioredis` connection. */
export function createRedisKeyStore(options?: RedisOptions): RedisKeyStore {
  return new RedisKeyStore(ioredisAdapter(createRedisConnection(options)));
}

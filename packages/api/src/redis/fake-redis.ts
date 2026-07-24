// Shared in-memory RedisLike for unit tests (avoids duplicating the fake across suites).

import type { RedisLike } from './client.js';

/** Minimal in-memory {@link RedisLike} with optional TTL tracking. */
export class FakeRedisLike implements RedisLike {
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

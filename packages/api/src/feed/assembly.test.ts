import { describe, it, expect } from 'vitest';
import type { UserRankingContext } from '@lumina/shared';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { CannedResult } from '../repositories/fake-queryable.js';
import { RedisKeyStore, type RedisLike } from '../redis/client.js';
import { FORYOU_TAB } from './candidates.js';
import { assembleFeed, MAX_FEED_PAGE_SIZE } from './assembly.js';

// Verifies Feed_Service scoring, ordering, paging, and feed-version tracking
// (design `assembleFeed` steps 2-4, Requirements 8.1, 8.2, 8.3, 8.7, 8.8):
//   - pages are bounded to 1-20 cards (8.1),
//   - candidates are ordered by DESCENDING Ranking_Engine score (8.3),
//   - cursor pages exclude previously-returned ids so a feed version never
//     repeats an article (8.2),
//   - every page carries a feed version and (when more remain) a next cursor,
//   - malformed/unknown cursors are rejected with a validation error and no
//     articles (8.7), and an invalid tab is rejected (delegated, 8.8).
//
// The database is faked with a responder-based FakeQueryable; the returned-set
// is the real RedisKeyStore backed by an in-memory RedisLike fake (the redis
// test pattern), so no live database or Redis is touched.

/** A complete `article` row in the snake_case shape `mapArticle` expects. */
function articleRow(id: string, qualityScore: number) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, '0'),
    source: 'wikipedia',
    title: `Title ${id}`,
    summary: 'Summary.',
    full_text: 'Body.',
    // No embedding + no onboarding topics => relevance falls back to 0, so the
    // score is monotonic in quality_score with recency held fixed. This makes
    // the descending-score ordering deterministic and easy to assert.
    embedding: null,
    quality_score: String(qualityScore),
    difficulty: 'intermediate',
    read_time_minutes: 7,
    summarization_status: 'summarized',
    published_at: new Date('2024-01-15T12:00:00.000Z'),
    ingested_at: new Date('2024-01-15T13:00:00.000Z'),
  };
}

/** A `topic` row in the shape `mapTopic` expects. */
interface TopicRow {
  id: string;
  slug: string;
  label: string;
  parent_id: string | null;
  color: string;
  icon_name: string;
  centroid: number[] | null;
}

interface FakeData {
  topic?: TopicRow | null;
  candidates?: ReturnType<typeof articleRow>[];
}

/** Build a responder-based FakeQueryable returning canned rows per statement. */
function fakeDb(data: FakeData): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM topic') && s.includes('slug = $1')) {
      return { rows: data.topic ? [data.topic] : [] };
    }
    if (s.includes('FROM user_topic') && s.includes('muted = true')) {
      return { rows: [] };
    }
    if (s.includes('FROM feed_event')) {
      return { rows: [] };
    }
    if (s.includes('FROM article a')) {
      return { rows: data.candidates ?? [] };
    }
    if (s.includes('FROM article_topic')) {
      // No topic associations => articles score with empty topics.
      return { rows: [] };
    }
    return { rows: [] };
  });
}

/**
 * Minimal in-memory {@link RedisLike} (the redis test pattern) — only the
 * commands the returned-set uses (sadd/smembers/expire) carry behaviour; the
 * rest satisfy the interface.
 */
class InMemoryRedis implements RedisLike {
  readonly sets = new Map<string, Set<string>>();
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {}
  async incr(): Promise<number> {
    return 0;
  }
  async expire(): Promise<void> {}
  async exists(key: string): Promise<boolean> {
    return this.sets.has(key);
  }
  async del(key: string): Promise<void> {
    this.sets.delete(key);
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

/** A user context with no embedding and no onboarding topics. */
const EMPTY_USER_CTX: UserRankingContext = {
  embedding: null,
  onboardingTopicIds: [],
};

/** Anchor the assembly clock to the fixtures' publish time so recency is fixed. */
const NOW_MS = Date.parse('2024-01-15T12:00:00.000Z');

/** Build assembly deps with a deterministic feed version and clock. */
function deps(db: FakeQueryable, redis: RedisLike, feedVersion = 'feed-v1') {
  return {
    db,
    redis: new RedisKeyStore(redis),
    newFeedVersion: () => feedVersion,
    now: () => NOW_MS,
  };
}

describe('assembleFeed — paging (Req 8.1)', () => {
  it('caps a page at 20 cards and emits a next cursor when more remain', async () => {
    const candidates = Array.from({ length: 25 }, (_, i) =>
      articleRow(`a${String(i).padStart(2, '0')}`, 0.5),
    );
    const db = fakeDb({ candidates });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.articles.length).toBe(MAX_FEED_PAGE_SIZE);
    expect(res.response.articles.length).toBeGreaterThanOrEqual(1);
    expect(res.response.nextCursor).not.toBeNull();
  });

  it('returns a short final page with no next cursor when nothing remains', async () => {
    const candidates = [articleRow('a1', 0.5), articleRow('a2', 0.6)];
    const db = fakeDb({ candidates });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.articles.length).toBe(2);
    expect(res.response.nextCursor).toBeNull();
  });
});

describe('assembleFeed — ordering (Req 8.3)', () => {
  it('orders candidates by descending Ranking_Engine score', async () => {
    // With relevance/recency fixed, the score is monotonic in quality_score,
    // so the descending-score order is the descending-quality order.
    const db = fakeDb({
      candidates: [
        articleRow('low', 0.2),
        articleRow('high', 0.9),
        articleRow('mid', 0.5),
      ],
    });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.articles.map((a) => a.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks score ties by ascending article id', async () => {
    const db = fakeDb({
      candidates: [
        articleRow('c', 0.5),
        articleRow('a', 0.5),
        articleRow('b', 0.5),
      ],
    });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.articles.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('assembleFeed — feed version + cursor metadata (Req 8.1, 8.2)', () => {
  it('returns the minted feed version and an opaque next cursor', async () => {
    const candidates = Array.from({ length: 21 }, (_, i) =>
      articleRow(`a${String(i).padStart(2, '0')}`, 0.5),
    );
    const db = fakeDb({ candidates });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis, 'feed-XYZ'), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.feedVersion).toBe('feed-XYZ');
    expect(typeof res.response.nextCursor).toBe('string');
  });
});

describe('assembleFeed — non-repeating cursor pages (Req 8.2)', () => {
  it('excludes ids returned by the preceding page within the same feed version', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      articleRow(`a${String(i).padStart(2, '0')}`, 0.5),
    );
    const db = fakeDb({ candidates });
    const redis = new InMemoryRedis();

    const first = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      userCtx: EMPTY_USER_CTX,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.response.articles.length).toBe(20);
    expect(first.response.nextCursor).not.toBeNull();

    const second = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      cursor: first.response.nextCursor,
      userCtx: EMPTY_USER_CTX,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const firstIds = new Set(first.response.articles.map((a) => a.id));
    const secondIds = second.response.articles.map((a) => a.id);
    // No article repeats across pages, and the second page holds the remainder.
    expect(secondIds.some((id) => firstIds.has(id))).toBe(false);
    expect(secondIds.length).toBe(10);
    // The two pages together cover the full candidate set exactly once.
    expect(new Set([...firstIds, ...secondIds]).size).toBe(30);
    // The second page continues the same feed version, now exhausted.
    expect(second.response.feedVersion).toBe(first.response.feedVersion);
    expect(second.response.nextCursor).toBeNull();
  });
});

describe('assembleFeed — invalid cursor (Req 8.7)', () => {
  it('rejects a malformed cursor with a validation error and no articles', async () => {
    const db = fakeDb({ candidates: [articleRow('a1', 0.5)] });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      cursor: '!!!not-a-valid-cursor!!!',
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.error.code).toBe('VALIDATION_ERROR');
    expect(res).not.toHaveProperty('response');
  });

  it('rejects a well-formed cursor for an unknown/expired feed version', async () => {
    const db = fakeDb({ candidates: [articleRow('a1', 0.5)] });
    const redis = new InMemoryRedis();
    // A syntactically valid cursor whose feed version was never recorded.
    const unknownCursor = Buffer.from(
      JSON.stringify({ v: 'never-seen', p: 0 }),
      'utf8',
    ).toString('base64url');

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: FORYOU_TAB,
      cursor: unknownCursor,
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('assembleFeed — invalid tab (Req 8.8, delegated)', () => {
  it('rejects an unknown tab slug with a validation error and no articles', async () => {
    const db = fakeDb({ topic: null });
    const redis = new InMemoryRedis();

    const res = await assembleFeed(deps(db, redis), {
      userId: 'u1',
      tab: 'not-a-topic',
      userCtx: EMPTY_USER_CTX,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.error.code).toBe('VALIDATION_ERROR');
    expect(res).not.toHaveProperty('response');
  });
});

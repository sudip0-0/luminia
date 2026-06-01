import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { UserRankingContext } from '@lumina/shared';

import { FakeQueryable, normalizeSql, type CannedResult } from '../repositories/fake-queryable.js';
import { RedisKeyStore, type RedisLike } from '../redis/client.js';
import { FORYOU_TAB, resolveCandidates } from './candidates.js';
import { assembleFeed, MAX_FEED_PAGE_SIZE } from './assembly.js';

// Property-based tests for Feed_Service candidate resolution + assembly.
// Each is annotated with its property number and the requirement it validates.

const NOW_MS = Date.parse('2024-01-15T12:00:00.000Z');
const EMPTY_USER_CTX: UserRankingContext = { embedding: null, onboardingTopicIds: [] };

/** A complete snake_case `article` row in the shape `mapArticle` expects. */
function articleRow(id: string) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, '0'),
    source: 'wikipedia',
    title: `Title ${id}`,
    summary: 'Summary.',
    full_text: 'Body.',
    embedding: null,
    quality_score: '0.5',
    difficulty: 'intermediate',
    read_time_minutes: 7,
    summarization_status: 'summarized',
    published_at: new Date(NOW_MS),
    ingested_at: new Date(NOW_MS),
  };
}

/** In-memory Redis exposing only the set commands the returned-set uses. */
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

/** A feed DB fake whose candidate pool is a fixed set of article ids. */
function feedDb(ids: readonly string[]): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM user_topic') && s.includes('muted = true')) return { rows: [] };
    if (s.includes('FROM feed_event')) return { rows: [] };
    if (s.includes('FROM article_topic')) return { rows: [] };
    if (s.includes('FROM article a')) return { rows: ids.map(articleRow) };
    return { rows: [] };
  });
}

function deps(db: FakeQueryable, redis: RedisLike) {
  return { db, redis: new RedisKeyStore(redis), newFeedVersion: () => 'fv', now: () => NOW_MS };
}

describe('Feed assembly — paging (Req 8.1)', () => {
  // Feature: lumina, Property 10: Feed pages are bounded in size
  it('Property 10: a feed page holds between 1 and 20 cards', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 80 }), async (n) => {
        const ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(3, '0')}`);
        const res = await assembleFeed(deps(feedDb(ids), new InMemoryRedis()), {
          userId: 'u1',
          tab: FORYOU_TAB,
          userCtx: EMPTY_USER_CTX,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const len = res.response.articles.length;
        expect(len).toBeGreaterThanOrEqual(1);
        expect(len).toBeLessThanOrEqual(MAX_FEED_PAGE_SIZE);
        expect(len).toBe(Math.min(n, MAX_FEED_PAGE_SIZE));
      }),
    );
  });
});

describe('Feed assembly — non-repeating pages (Req 8.2)', () => {
  // Feature: lumina, Property 11: A feed version never repeats an article across pages
  it('Property 11: paging a feed version yields each article at most once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 70 }), async (n) => {
        const ids = Array.from({ length: n }, (_, i) => `a${String(i).padStart(3, '0')}`);
        const db = feedDb(ids);
        const redis = new InMemoryRedis();
        const seen: string[] = [];
        let cursor: string | null | undefined;
        // Follow cursors until exhausted (bounded by ceil(n/20)+1 pages).
        for (let page = 0; page <= Math.ceil(n / MAX_FEED_PAGE_SIZE); page += 1) {
          const res = await assembleFeed(deps(db, redis), {
            userId: 'u1',
            tab: FORYOU_TAB,
            cursor,
            userCtx: EMPTY_USER_CTX,
          });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          seen.push(...res.response.articles.map((a) => a.id));
          cursor = res.response.nextCursor;
          if (cursor === null) break;
        }
        expect(new Set(seen).size).toBe(seen.length); // no repeats
        expect(new Set(seen).size).toBe(n); // every candidate exactly once
      }),
      { numRuns: 50 },
    );
  });
});

/**
 * A resolution DB fake that faithfully models the layering: the candidate query
 * returns the already-topic-restricted, skip-excluded pool (the DB's job), and
 * the article_topic / muted-topic queries feed the in-code muted exclusion.
 */
function resolutionDb(opts: {
  dbPool: { id: string; topicId: string }[];
  associations: { id: string; topicId: string }[];
  mutedTopicIds: string[];
  topicExists: boolean;
}): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM topic') && s.includes('slug = $1')) {
      return {
        rows: opts.topicExists
          ? [{ id: 't-resolved', slug: 'x', label: 'X', parent_id: null, color: '#fff', icon_name: 'i', centroid: null }]
          : [],
      };
    }
    if (s.includes('FROM user_topic') && s.includes('muted = true')) {
      return { rows: opts.mutedTopicIds.map((topic_id) => ({ topic_id })) };
    }
    if (s.includes('FROM feed_event')) return { rows: [] };
    if (s.includes('FROM article a')) return { rows: opts.dbPool.map((a) => articleRow(a.id)) };
    if (s.includes('FROM article_topic')) {
      return {
        rows: opts.associations.map((a) => ({
          article_id: a.id,
          topic_id: a.topicId,
          confidence: 0.9,
        })),
      };
    }
    return { rows: [] };
  });
}

describe('Feed candidates — topic-tab restriction (Req 8.4)', () => {
  // Feature: lumina, Property 12: Topic-tab feeds are restricted to the topic
  it('Property 12: foryou yields no restriction; an unknown slug errors; a known slug resolves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(FORYOU_TAB, 'known-slug', 'unknown-slug'),
        async (tab) => {
          const db = resolutionDb({
            dbPool: [{ id: 'a1', topicId: 't-resolved' }],
            associations: [{ id: 'a1', topicId: 't-resolved' }],
            mutedTopicIds: [],
            topicExists: tab === 'known-slug',
          });
          const res = await resolveCandidates({ db }, { userId: 'u1', tab });
          if (tab === FORYOU_TAB) {
            expect(res.ok).toBe(true);
            if (res.ok) expect(res.result.topicId).toBeNull();
          } else if (tab === 'known-slug') {
            expect(res.ok).toBe(true);
            if (res.ok) expect(res.result.topicId).toBe('t-resolved');
          } else {
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.error.error.code).toBe('VALIDATION_ERROR');
          }
        },
      ),
    );
  });
});

describe('Feed candidates — muted exclusion (Req 25.2, 8.6)', () => {
  // Feature: lumina, Property 14: Excluded articles never appear in the feed
  it('Property 14: no article associated with a muted topic survives resolution', async () => {
    const topicIds = ['t1', 't2', 't3'];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.integer({ min: 0, max: 999 }).map((n) => `a${n}`),
            topicId: fc.constantFrom(...topicIds),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.subarray(topicIds),
        async (rawPool, mutedTopicIds) => {
          // De-duplicate ids so a single article maps to a single topic here.
          const seen = new Set<string>();
          const dbPool = rawPool.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
          const db = resolutionDb({
            dbPool,
            associations: dbPool,
            mutedTopicIds,
            topicExists: true,
          });
          const res = await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          const muted = new Set(mutedTopicIds);
          const survivingTopics = res.result.candidates.map(
            (c) => dbPool.find((a) => a.id === c.id)!.topicId,
          );
          expect(survivingTopics.some((t) => muted.has(t))).toBe(false);
        },
      ),
    );
  });
});

// Feed_Service — scoring, ordering, paging, and feed-version tracking.
//
// Implements steps 2-4 of the design's `assembleFeed` flow (Requirements 8.1,
// 8.2, 8.3, 8.7, 8.8). Step 1 (candidate resolution and exclusions) lives in
// ./candidates and is delegated to here; serendipity injection (step 3, task
// 13.7) is intentionally NOT performed in this module.
//
// Given the resolved candidate pool, `assembleFeed`:
//   1. Resolves candidates via {@link resolveCandidates}, which rejects an
//      invalid tab with a uniform validation error (Requirement 8.8).
//   2. Scores each candidate via the Ranking_Engine — the `foryou` tab uses the
//      personalized score (Requirement 8.3) — and sorts DESCENDING by score,
//      breaking ties stably by ascending article id.
//   3. Excludes any article already returned under the feed version
//      (Requirement 8.2), pages to between 1 and 20 cards (Requirement 8.1),
//      records the returned ids under the feed version so subsequent cursor
//      pages never repeat (Requirement 8.2), and emits an opaque `nextCursor`
//      (encoding the feed version + position) together with the `feedVersion`.
//
// On an initial request (no cursor) a new feed version is minted; on a cursor
// request the cursor is decoded and validated. A malformed, expired, or unknown
// cursor is rejected with a uniform validation error WITHOUT returning any feed
// articles (Requirement 8.7).
//
// Redis and the database are injected behind narrow interfaces (the
// {@link FeedReturnedSet} returned-set surface and the repository `Queryable`),
// so assembly is fully unit-testable with an in-memory fake Redis and a
// `FakeQueryable` — it never opens a network connection.

import { randomUUID } from 'node:crypto';

import {
  ERROR_CODES,
  makeError,
  scoreArticle,
  type ApiErrorEnvelope,
  type Article,
  type ArticleTopicAssociation,
  type FeedResponse,
  type RankingWeights,
  type SessionRankingContext,
  type UserRankingContext,
} from '@lumina/shared';

import { listTopicIdsForArticles } from '../repositories/index.js';
import type {
  ArticleRecord,
  ArticleTopicRecord,
  Queryable,
} from '../repositories/index.js';

import { resolveCandidates } from './candidates.js';

/**
 * Maximum number of cards returned in a single feed page (Requirement 8.1: a
 * ranked list of between 1 and 20 articles). A page never exceeds this; it may
 * contain fewer when the (post-exclusion) candidate pool is smaller.
 */
export const MAX_FEED_PAGE_SIZE = 20;

/**
 * The narrow Redis surface assembly needs: the per-feed-version "already
 * returned" set used so cursor pages never repeat an article (Requirement 8.2).
 * A {@link import('../redis/index.js').RedisKeyStore} satisfies this
 * structurally; unit tests supply an in-memory fake.
 */
export interface FeedReturnedSet {
  /** All article ids already returned within the feed version. */
  getReturnedArticles(feedVersion: string): Promise<string[]>;
  /** Record article ids as returned within the feed version (refreshing TTL). */
  addReturnedArticles(
    feedVersion: string,
    articleIds: string[],
    ttlSeconds?: number,
  ): Promise<void>;
}

/** Dependencies injected into {@link assembleFeed}. */
export interface FeedAssemblyDeps {
  /** The shared query surface (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
  /** The per-feed-version returned-set store (Redis in production, a fake in tests). */
  redis: FeedReturnedSet;
  /**
   * Mints a new feed version on an initial (cursorless) request. Defaults to a
   * v4 UUID; injected so tests get a deterministic feed version.
   */
  newFeedVersion?: () => string;
  /**
   * Supplies the assembly clock as epoch milliseconds, used to derive article
   * age for the recency component. Defaults to `Date.now`; injected so tests
   * stay deterministic.
   */
  now?: () => number;
}

/** A single {@link assembleFeed} request. */
export interface AssembleFeedInput {
  /** The authenticated user the feed is being assembled for. */
  userId: string;
  /** `'foryou'` for the personalized feed, otherwise a topic slug. */
  tab: string;
  /**
   * The opaque cursor from a previous page, or `null`/`undefined` for the
   * initial request. A non-empty cursor is decoded and validated; a malformed,
   * expired, or unknown cursor is rejected (Requirement 8.7).
   */
  cursor?: string | null;
  /**
   * The user ranking context (embedding or onboarding topics) the Ranking_Engine
   * scores against. For the `foryou` tab this yields the personalized score
   * (Requirement 8.3).
   */
  userCtx: UserRankingContext;
  /**
   * Optional session ranking context (per-source card counts and the assembly
   * clock). When omitted a minimal context is built from {@link FeedAssemblyDeps.now}
   * so recency is still anchored to the assembly time.
   */
  sessionCtx?: SessionRankingContext;
  /** Optional ranking-weight override; defaults to the Ranking_Engine defaults. */
  weights?: RankingWeights;
}

/**
 * The discriminated result of {@link assembleFeed}: either the assembled page
 * (1-20 ranked articles, a `nextCursor`, and the `feedVersion`), or the uniform
 * error envelope when the tab is invalid (Requirement 8.8) or the cursor is
 * malformed/expired/unknown (Requirement 8.7). The error variant never carries
 * feed articles.
 */
export type AssembleFeedResult =
  | { ok: true; response: FeedResponse }
  | { ok: false; error: ApiErrorEnvelope };

/** The decoded contents of a feed cursor: the feed version and page position. */
interface FeedCursor {
  /** The feed version the cursor pages within. */
  feedVersion: string;
  /** Cumulative number of articles returned by preceding pages (an offset). */
  position: number;
}

/**
 * Encode a feed cursor into an opaque base64url token (feed version + position).
 * The token is intentionally opaque to clients; only {@link decodeFeedCursor}
 * interprets it.
 */
function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(
    JSON.stringify({ v: cursor.feedVersion, p: cursor.position }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode an opaque feed cursor. Returns `null` when the token is malformed —
 * not valid base64url JSON, or missing/ill-typed fields — so the caller can
 * reject it with a uniform validation error (Requirement 8.7).
 */
function decodeFeedCursor(raw: string): FeedCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = (parsed as { v?: unknown }).v;
  const p = (parsed as { p?: unknown }).p;
  if (
    typeof v === 'string' &&
    v.length > 0 &&
    typeof p === 'number' &&
    Number.isInteger(p) &&
    p >= 0
  ) {
    return { feedVersion: v, position: p };
  }
  return null;
}

/** The uniform validation error for a malformed/expired/unknown cursor (Req 8.7). */
function invalidCursorError(): ApiErrorEnvelope {
  return makeError(ERROR_CODES.VALIDATION_ERROR, 'Invalid feed cursor', {
    field: 'cursor',
  });
}

/** Map a persisted topic-association row to the shared wire shape. */
function toAssociation(row: ArticleTopicRecord): ArticleTopicAssociation {
  return { topicId: row.topicId, confidence: row.confidence };
}

/** Map an article record plus its topic associations to the shared `Article`. */
function toArticle(
  record: ArticleRecord,
  topics: ArticleTopicAssociation[],
): Article {
  return {
    id: record.id,
    url: record.url,
    source: record.source,
    title: record.title,
    summary: record.summary,
    fullText: record.fullText,
    embedding: record.embedding,
    qualityScore: record.qualityScore,
    difficulty: record.difficulty,
    readTimeMinutes: record.readTimeMinutes,
    topics,
    publishedAt: record.publishedAt,
    ingestedAt: record.ingestedAt,
  };
}

/**
 * Load the topic associations for every candidate in one batched query and
 * group them by article id, preserving the repository's descending-confidence
 * order. Returns an empty map for an empty pool (no query issued).
 */
async function loadTopicsByArticle(
  db: Queryable,
  records: readonly ArticleRecord[],
): Promise<Map<string, ArticleTopicAssociation[]>> {
  const grouped = new Map<string, ArticleTopicAssociation[]>();
  if (records.length === 0) return grouped;
  const rows = await listTopicIdsForArticles(
    db,
    records.map((r) => r.id),
  );
  for (const row of rows) {
    const existing = grouped.get(row.articleId);
    if (existing) {
      existing.push(toAssociation(row));
    } else {
      grouped.set(row.articleId, [toAssociation(row)]);
    }
  }
  return grouped;
}

/**
 * Assemble a paginated, ranked feed page (design `assembleFeed` steps 2-4).
 *
 * 1. Resolve the candidate pool via {@link resolveCandidates}, which excludes
 *    muted-topic and prior-skip articles and rejects an invalid tab with a
 *    uniform validation error (Requirements 8.4, 8.6, 8.8, 25.2).
 * 2. Score each candidate via the Ranking_Engine and sort DESCENDING by score,
 *    breaking ties by ascending article id (Requirements 8.1, 8.3).
 * 3. Exclude any article already returned under the feed version
 *    (Requirement 8.2), page to at most {@link MAX_FEED_PAGE_SIZE} cards
 *    (Requirement 8.1), record the page's ids under the feed version
 *    (Requirement 8.2), and emit an opaque `nextCursor` plus the `feedVersion`.
 *
 * On an initial request (no cursor) a new feed version is minted. On a cursor
 * request the cursor is decoded and validated against the feed version's
 * returned-set; a malformed, expired, or unknown cursor is rejected with a
 * uniform validation error and NO articles (Requirement 8.7).
 */
export async function assembleFeed(
  deps: FeedAssemblyDeps,
  input: AssembleFeedInput,
): Promise<AssembleFeedResult> {
  const { db, redis } = deps;
  const newFeedVersion = deps.newFeedVersion ?? randomUUID;
  const now = deps.now ?? Date.now;
  const hasCursor = typeof input.cursor === 'string' && input.cursor.length > 0;

  // (8.7) A supplied cursor must decode to a well-formed feed cursor. Reject a
  // malformed cursor up front, before any database work, with no articles.
  let decodedCursor: FeedCursor | null = null;
  if (hasCursor) {
    decodedCursor = decodeFeedCursor(input.cursor as string);
    if (!decodedCursor) {
      return { ok: false, error: invalidCursorError() };
    }
  }

  // (8.4, 8.6, 8.8, 25.2) Resolve the candidate pool. An invalid tab is rejected
  // here with a uniform validation error, delegated from candidate resolution.
  const resolution = await resolveCandidates({ db }, { userId: input.userId, tab: input.tab });
  if (!resolution.ok) {
    return { ok: false, error: resolution.error };
  }
  const { candidates } = resolution.result;

  // Determine the feed version and the set of already-returned ids.
  let feedVersion: string;
  let position: number;
  let returnedIds: string[];
  if (decodedCursor) {
    feedVersion = decodedCursor.feedVersion;
    position = decodedCursor.position;
    // (8.7) The cursor must correspond to a KNOWN feed position. The returned-set
    // is created only when a preceding page recorded ids, so an empty set means
    // the feed version is unknown or its session has expired — reject it.
    returnedIds = await redis.getReturnedArticles(feedVersion);
    if (returnedIds.length === 0) {
      return { ok: false, error: invalidCursorError() };
    }
  } else {
    feedVersion = newFeedVersion();
    position = 0;
    returnedIds = [];
  }

  // (8.3) Score each candidate via the Ranking_Engine. Topic associations are
  // loaded so novelty and the onboarding relevance fallback are meaningful.
  const topicsByArticle = await loadTopicsByArticle(db, candidates);
  const sessionCtx: SessionRankingContext =
    input.sessionCtx ?? { sourceCardCounts: {}, avgCardsPerSource: 0, nowMs: now() };

  const scored = candidates.map((record) => {
    const article = toArticle(record, topicsByArticle.get(record.id) ?? []);
    return { article, score: scoreArticle(article, input.userCtx, sessionCtx, input.weights) };
  });

  // Sort DESCENDING by score; break ties stably by ascending article id so the
  // ordering is deterministic and independent of the candidate pool's order.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.article.id < b.article.id) return -1;
    if (a.article.id > b.article.id) return 1;
    return 0;
  });

  // (8.2) Exclude any article already returned under this feed version.
  const returned = new Set(returnedIds);
  const eligible = scored.filter((s) => !returned.has(s.article.id));

  // (8.1) Page to at most MAX_FEED_PAGE_SIZE cards.
  const page = eligible.slice(0, MAX_FEED_PAGE_SIZE);
  const articles = page.map((s) => s.article);

  // (8.2) Record this page's ids under the feed version so later cursor pages
  // never repeat them (a no-op for an empty page).
  const pageIds = articles.map((a) => a.id);
  await redis.addReturnedArticles(feedVersion, pageIds);

  // Emit a next cursor only when eligible candidates remain beyond this page.
  const hasMore = eligible.length > page.length;
  const nextCursor = hasMore
    ? encodeFeedCursor({ feedVersion, position: position + articles.length })
    : null;

  return { ok: true, response: { articles, nextCursor, feedVersion } };
}

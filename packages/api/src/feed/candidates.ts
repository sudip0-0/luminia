// Feed_Service — candidate resolution and exclusions.
//
// Implements step 1 of the design's `assembleFeed` flow: build the candidate
// article pool that
//   (a) EXCLUDES any article associated with a topic the user currently mutes
//       (Requirement 25.2),
//   (b) EXCLUDES any article the user has previously recorded a `skip`
//       Feed_Event against (Requirement 8.6), and
//   (c) RESTRICTS the pool to a single topic when `tab` is a topic slug, while
//       applying no topic restriction for the `foryou` tab (Requirement 8.4).
//
// Scoring, ordering, paging, serendipity injection, and tab listing are
// implemented by separate tasks; this module only resolves the pool that those
// steps consume. All database access goes through the narrow {@link Queryable}
// interface and the existing repository functions, so the resolver is fully
// unit-testable with an in-memory FakeQueryable and never opens a network
// connection.

import {
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
} from '@lumina/shared';
import {
  findTopicBySlug,
  listArticleCandidates,
  listMutedTopicIds,
  listTopicIdsForArticles,
  type ArticleRecord,
  type ListArticleCandidatesFilter,
  type Queryable,
  queryRows,
} from '../repositories/index.js';

/** The reserved tab key for the personalized (non-topic-restricted) feed. */
export const FORYOU_TAB = 'foryou';

/**
 * Default size of the candidate pool fetched before exclusions. Kept larger
 * than a single feed page (1-20) so the pool stays useful after muted-topic and
 * skip exclusions; final page sizing is the scoring/paging step's concern.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200;

/** Dependencies injected into {@link resolveCandidates}. */
export interface CandidateResolutionDeps {
  /** The shared query surface (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
}

/** A single candidate-resolution request. */
export interface ResolveCandidatesInput {
  /** The authenticated user the feed is being assembled for. */
  userId: string;
  /** `'foryou'` for the personalized feed, otherwise a topic slug. */
  tab: string;
  /** Maximum pool size to fetch before exclusions; defaults to {@link DEFAULT_CANDIDATE_LIMIT}. */
  limit?: number;
}

/** The resolved candidate pool plus the metadata downstream steps consume. */
export interface ResolvedCandidates {
  /** Resolved topic id when `tab` is a slug; `null` for the `foryou` tab. */
  topicId: string | null;
  /** The candidate articles after all exclusions and the optional restriction. */
  candidates: ArticleRecord[];
  /** Topic ids the user currently mutes (their articles were excluded). */
  mutedTopicIds: string[];
  /** Article ids the user has previously skipped (excluded from the pool). */
  skippedArticleIds: string[];
}

/**
 * The discriminated result of candidate resolution: either the resolved pool,
 * or the uniform error envelope when `tab` is neither `foryou` nor an existing
 * topic slug (so a topic restriction cannot be resolved).
 */
export type CandidateResolution =
  | { ok: true; result: ResolvedCandidates }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Return the distinct article ids the user has previously recorded a `skip`
 * Feed_Event against (Requirement 8.6). Parameterized; `'skip'` is bound as a
 * value, never interpolated. `session_end` skips carry no article, so the
 * `article_id IS NOT NULL` guard keeps the result a clean id list.
 */
async function findSkippedArticleIds(
  db: Queryable,
  userId: string,
): Promise<string[]> {
  const sql = `
    SELECT DISTINCT article_id FROM feed_event
    WHERE user_id = $1 AND type = $2 AND article_id IS NOT NULL
  `;
  const rows = await queryRows<{ article_id: string }>(db, sql, [userId, 'skip']);
  return rows.map((r) => r.article_id);
}

/**
 * Remove from `pool` every article associated with any of `mutedTopicIds`
 * (Requirement 25.2). The association lookup is a single batched query over the
 * pool's ids; an empty pool or no muted topics short-circuits without a query.
 */
async function excludeMutedTopicArticles(
  db: Queryable,
  pool: readonly ArticleRecord[],
  mutedTopicIds: readonly string[],
): Promise<ArticleRecord[]> {
  if (pool.length === 0 || mutedTopicIds.length === 0) return [...pool];

  const muted = new Set(mutedTopicIds);
  const associations = await listTopicIdsForArticles(
    db,
    pool.map((article) => article.id),
  );

  const mutedArticleIds = new Set<string>();
  for (const association of associations) {
    if (muted.has(association.topicId)) {
      mutedArticleIds.add(association.articleId);
    }
  }

  return pool.filter((article) => !mutedArticleIds.has(article.id));
}

/**
 * Resolve the candidate article pool for a feed request (design `assembleFeed`
 * step 1).
 *
 * 1. Resolve `tab`: `foryou` applies no topic restriction; any other value must
 *    be an existing topic slug, otherwise an invalid-tab validation error is
 *    returned (Requirement 8.4).
 * 2. Gather the user's muted topics (Requirement 25.2) and prior-skip article
 *    ids (Requirement 8.6).
 * 3. Fetch candidates restricted to the resolved topic (when any) and with the
 *    skipped articles already excluded at the database layer.
 * 4. Drop any remaining candidate associated with a muted topic.
 */
export async function resolveCandidates(
  deps: CandidateResolutionDeps,
  input: ResolveCandidatesInput,
): Promise<CandidateResolution> {
  const { db } = deps;
  const { userId, tab } = input;
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;

  // (1) Resolve the tab to an optional topic restriction.
  let topicId: string | null = null;
  if (tab !== FORYOU_TAB) {
    const topic = await findTopicBySlug(db, tab);
    if (!topic) {
      return {
        ok: false,
        error: makeError(
          ERROR_CODES.VALIDATION_ERROR,
          `Unknown feed tab: ${tab}`,
          { tab },
        ),
      };
    }
    topicId = topic.id;
  }

  // (2) Gather the exclusion inputs (independent reads).
  const [mutedTopicIds, skippedArticleIds] = await Promise.all([
    listMutedTopicIds(db, userId),
    findSkippedArticleIds(db, userId),
  ]);

  // (3) Fetch the pool: topic-restricted when a slug was given, with prior
  //     skips excluded at the database layer (Requirements 8.4, 8.6).
  const filter: ListArticleCandidatesFilter = {
    excludeArticleIds: skippedArticleIds,
    limit,
  };
  if (topicId !== null) {
    filter.topicId = topicId;
  }
  const pool = await listArticleCandidates(db, filter);

  // (4) Drop candidates associated with a muted topic (Requirement 25.2).
  const candidates = await excludeMutedTopicArticles(db, pool, mutedTopicIds);

  return {
    ok: true,
    result: { topicId, candidates, mutedTopicIds, skippedArticleIds },
  };
}

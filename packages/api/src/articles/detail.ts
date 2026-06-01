// Feed_Service — article detail and related-article retrieval.
//
// Implements the design's Feed_Service `getArticleDetail` / `getRelated`
// behaviours (Requirements 11.1-11.4, 20.1, 20.3):
//   - `getArticleDetail` returns the full article detail together with related
//     articles for an existing article (Requirement 20.1); returns a uniform
//     NOT_FOUND error when the source article does not exist, without returning
//     any partial detail (Requirements 11.4, 20.2-area).
//   - Related articles are up to 5 DISTINCT articles ordered by DESCENDING
//     cosine similarity to the source embedding, EXCLUDING the source, resolved
//     via the pgvector `<=>` operator in the repository layer (Requirements
//     11.1, 11.2). When no candidates remain the result is the empty set
//     (Requirement 11.3).
//   - If related retrieval FAILS (the neighbour query throws), the detail is
//     still returned WITHOUT related articles rather than failing the whole
//     request (Requirement 20.3 — graceful degradation).
//
// All database access is injected behind {@link ArticleDataAccess}, whose
// production implementation ({@link createArticleDataAccess}) wires the
// repository functions over a `Queryable`. Unit tests construct it over a
// `FakeQueryable`, so the service is fully exercisable without a live database
// or pgvector.

import type { Article, ApiErrorEnvelope, ArticleTopicAssociation } from '@lumina/shared';
import { ERROR_CODES, makeError } from '@lumina/shared';
import {
  findArticleById,
  findArticlesByEmbeddingSimilarity,
  listArticleTopics,
  listTopicIdsForArticles,
  type ArticleRecord,
  type ArticleTopicRecord,
  type Queryable,
} from '../repositories/index.js';

/**
 * The maximum number of related articles returned for an article
 * (Requirement 11.1: "up to 5 distinct articles").
 */
export const MAX_RELATED_ARTICLES = 5;

/**
 * The full article detail returned by {@link getArticleDetail}: the source
 * article (with its topic associations) plus its related articles. `related`
 * is the empty array both when no candidates remain (Requirement 11.3) and when
 * related retrieval failed and the detail degraded gracefully
 * (Requirement 20.3).
 */
export interface ArticleDetail {
  article: Article;
  related: Article[];
}

/** The discriminated outcome of an {@link getArticleDetail} request. */
export type ArticleDetailResult =
  /** The article exists; `detail` carries the full detail and related set. */
  | { status: 'ok'; detail: ArticleDetail }
  /** No such article; `error` is the uniform NOT_FOUND envelope (no partial detail). */
  | { status: 'not-found'; error: ApiErrorEnvelope };

/** The discriminated outcome of a {@link getRelatedArticles} request. */
export type RelatedArticlesResult =
  /** The source article exists; `related` is the (possibly empty) related set. */
  | { status: 'ok'; related: Article[] }
  /** No such source article; `error` is the uniform NOT_FOUND envelope. */
  | { status: 'not-found'; error: ApiErrorEnvelope };

/**
 * The narrow data-access surface the article-detail service depends on. Keeping
 * it an interface (rather than a `Queryable` directly) lets the related-article
 * neighbour query be exercised — including its failure path (Requirement 20.3)
 * — independently of the article and topic reads. The production implementation
 * is {@link createArticleDataAccess}.
 */
export interface ArticleDataAccess {
  /** Fetch a single article by id, or `null` when it does not exist. */
  getArticleById(id: string): Promise<ArticleRecord | null>;
  /**
   * Fetch the nearest neighbours to `embedding` by cosine distance (pgvector
   * `<=>`), excluding `excludeArticleId`, capped at `limit`, ordered by
   * descending similarity (ascending distance).
   */
  getRelatedByEmbedding(
    embedding: readonly number[],
    options: { excludeArticleId: string; limit: number },
  ): Promise<ArticleRecord[]>;
  /** The topic associations for one article, ordered by descending confidence. */
  getTopicsForArticle(articleId: string): Promise<ArticleTopicRecord[]>;
  /** The topic associations for many articles in a single query. */
  getTopicsForArticles(
    articleIds: readonly string[],
  ): Promise<ArticleTopicRecord[]>;
}

/**
 * Wire {@link ArticleDataAccess} to the repository layer over a `Queryable`.
 * Production code passes a live `pg`-backed `Queryable` (via `fromPool`); unit
 * tests pass a `FakeQueryable`.
 */
export function createArticleDataAccess(db: Queryable): ArticleDataAccess {
  return {
    getArticleById: (id) => findArticleById(db, id),
    getRelatedByEmbedding: (embedding, options) =>
      findArticlesByEmbeddingSimilarity(db, embedding, options),
    getTopicsForArticle: (articleId) => listArticleTopics(db, articleId),
    getTopicsForArticles: (articleIds) =>
      listTopicIdsForArticles(db, articleIds),
  };
}

/** Map a persisted topic association row to the shared wire shape. */
function toAssociation(row: ArticleTopicRecord): ArticleTopicAssociation {
  return { topicId: row.topicId, confidence: row.confidence };
}

/**
 * Group topic-association rows by article id, preserving each group's input
 * order (the repository returns them ordered by descending confidence).
 */
function groupTopicsByArticle(
  rows: readonly ArticleTopicRecord[],
): Map<string, ArticleTopicAssociation[]> {
  const grouped = new Map<string, ArticleTopicAssociation[]>();
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

/** Build the uniform NOT_FOUND envelope for a missing source article. */
function articleNotFound(articleId: string): ApiErrorEnvelope {
  return makeError(ERROR_CODES.NOT_FOUND, 'Article not found', { articleId });
}

/**
 * Resolve the related articles for an already-loaded source article. Returns up
 * to {@link MAX_RELATED_ARTICLES} DISTINCT articles ordered by descending
 * cosine similarity, excluding the source (Requirements 11.1, 11.2), and the
 * empty array when no candidates remain (Requirement 11.3).
 *
 * The neighbour ordering and exclusion are produced by the pgvector `<=>` query
 * in the repository; this function additionally enforces the source-exclusion,
 * distinctness, and cap defensively so the contract holds regardless of the
 * underlying row set. A source article without an embedding has no similarity
 * basis and therefore yields the empty set.
 *
 * This function does NOT catch errors — a failing neighbour query propagates so
 * that {@link getArticleDetail} can degrade gracefully (Requirement 20.3) while
 * {@link getRelatedArticles} surfaces the failure to its caller.
 */
async function resolveRelatedArticles(
  deps: ArticleDataAccess,
  source: ArticleRecord,
): Promise<Article[]> {
  if (source.embedding === null || source.embedding.length === 0) {
    return [];
  }

  const neighbours = await deps.getRelatedByEmbedding(source.embedding, {
    excludeArticleId: source.id,
    limit: MAX_RELATED_ARTICLES,
  });

  // Defensively exclude the source, drop duplicates, and cap at the maximum,
  // preserving the descending-similarity order returned by the query.
  const seen = new Set<string>();
  const distinct: ArticleRecord[] = [];
  for (const candidate of neighbours) {
    if (candidate.id === source.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    distinct.push(candidate);
    if (distinct.length >= MAX_RELATED_ARTICLES) break;
  }

  if (distinct.length === 0) return [];

  const topicRows = await deps.getTopicsForArticles(distinct.map((a) => a.id));
  const topicsByArticle = groupTopicsByArticle(topicRows);
  return distinct.map((a) => toArticle(a, topicsByArticle.get(a.id) ?? []));
}

/**
 * Return up to {@link MAX_RELATED_ARTICLES} related articles for the given
 * source article (Requirements 11.1-11.3). Returns a NOT_FOUND result when the
 * source article does not exist (Requirement 11.4). Unlike
 * {@link getArticleDetail}, a failure of the underlying neighbour query is NOT
 * suppressed here — the caller decides how to handle it.
 */
export async function getRelatedArticles(
  deps: ArticleDataAccess,
  articleId: string,
): Promise<RelatedArticlesResult> {
  const source = await deps.getArticleById(articleId);
  if (!source) {
    return { status: 'not-found', error: articleNotFound(articleId) };
  }
  const related = await resolveRelatedArticles(deps, source);
  return { status: 'ok', related };
}

/**
 * Return the full detail for an existing article together with its related
 * articles (Requirement 20.1). When the source article does not exist, returns
 * a uniform NOT_FOUND result and no partial detail (Requirements 11.4, 20.2).
 *
 * Related retrieval is best-effort: if the neighbour query throws, the detail is
 * still returned with an empty `related` set rather than failing the whole
 * request (Requirement 20.3). The not-found determination, however, depends
 * only on the source article — a missing source is always NOT_FOUND
 * (Requirement 11.4).
 */
export async function getArticleDetail(
  deps: ArticleDataAccess,
  articleId: string,
): Promise<ArticleDetailResult> {
  const source = await deps.getArticleById(articleId);
  if (!source) {
    return { status: 'not-found', error: articleNotFound(articleId) };
  }

  const sourceTopics = await deps.getTopicsForArticle(articleId);
  const article = toArticle(source, sourceTopics.map(toAssociation));

  // (20.3) Related articles are best-effort: degrade to no related articles
  // rather than failing the detail when neighbour retrieval throws.
  let related: Article[] = [];
  try {
    related = await resolveRelatedArticles(deps, source);
  } catch {
    related = [];
  }

  return { status: 'ok', detail: { article, related } };
}

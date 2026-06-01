// Ranking_Engine — a pure, in-process scoring library (no I/O).
//
// Mirrors the "Ranking_Engine" subsection of "Components and Interfaces" in the
// design document. The engine scores a candidate Article for a user as the
// weighted sum of six normalized components — relevance, novelty, quality,
// recency, diversity, and serendipity — each in [0.0, 1.0] (Requirement 9).
//
// Because the engine performs no I/O, the caller supplies everything it needs:
// the user context (embedding or onboarding topics), the session context
// (per-source card counts and the assembly clock), and the article itself.
// This keeps the engine deterministic and cheap to property-test exhaustively.
//
// This module implements task 11.1 (the component functions and the
// weighted-sum score), task 11.5 (bandit weight tuning with re-normalization,
// {@link applyBanditTuning}), and task 11.7 (serendipity *article selection*,
// {@link selectSerendipityArticle}). It also implements the serendipity
// *component value* ({@link serendipity}) used during scoring; that value and
// the selection of a Serendipity_Card are distinct concerns (Requirement 10).

import type { Article } from './domain.js';
import { DEFAULT_RANKING_WEIGHTS, type RankingComponents, type RankingWeights } from './ranking.js';

/**
 * The dimensionality of user and article embedding vectors (Requirement 7.5).
 * Relevance falls back to the onboarding topic-match ratio when an embedding of
 * this width is not available on both sides (Requirement 9.7).
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Maximum diversity bonus added to the diversity component for an Article whose
 * Source is under-represented in the current session (Requirement 9.5).
 */
export const MAX_DIVERSITY_BONUS = 0.2;

/** Number of milliseconds in one hour, used to derive article age in hours. */
const MS_PER_HOUR = 3_600_000;

/**
 * Context describing the user for whom an Article is being scored.
 *
 * When {@link embedding} is a valid {@link EMBEDDING_DIMENSIONS}-wide vector the
 * relevance component is the normalized cosine similarity; otherwise relevance
 * falls back to the onboarding topic-match ratio (Requirements 9.2, 9.7).
 */
export interface UserRankingContext {
  /**
   * The user's embedding vector, or `null` when the user has no User_Embedding
   * (e.g. before the learning job has run). Absence triggers the onboarding
   * topic-match fallback for the relevance component (Requirement 9.7).
   */
  embedding: number[] | null;
  /**
   * Topic ids the user selected during onboarding. Used to compute the
   * relevance fallback as the fraction of the Article's topics that match these
   * onboarding topics (Requirement 9.7).
   */
  onboardingTopicIds: readonly string[];
  /**
   * Topic ids the user has already engaged with. Used to compute novelty as the
   * fraction of the Article's topics the user has not yet engaged with. When
   * omitted or empty, every topic is treated as novel.
   */
  engagedTopicIds?: readonly string[];
}

/**
 * Context describing the in-progress feed session.
 *
 * Carries the per-source card counts and the average cards per enabled source
 * (for the diversity bonus, Requirement 9.5), and the assembly clock used to
 * derive each Article's age in hours (for the recency component, Requirement
 * 9.3). The clock is supplied by the caller to keep the engine pure.
 */
export interface SessionRankingContext {
  /** Number of cards each Source has already supplied in the current session. */
  sourceCardCounts: Readonly<Record<string, number>>;
  /** Average number of cards per enabled Source in the current session. */
  avgCardsPerSource: number;
  /** Assembly time as epoch milliseconds; article age is measured against it. */
  nowMs: number;
}

/** Clamps `value` into the inclusive range [`min`, `max`]. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamps `value` into the inclusive range [0, 1]. */
function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when the
 * vectors differ in length or when either vector has zero magnitude (so the
 * normalized relevance becomes the neutral midpoint 0.5).
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** True iff `vector` is a usable embedding of {@link EMBEDDING_DIMENSIONS} finite numbers. */
function isUsableEmbedding(vector: number[] | null | undefined): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => Number.isFinite(n))
  );
}

/**
 * Fraction of the Article's associated topics that match `onboardingTopicIds`,
 * in [0, 1]. Returns 0 when the Article has no associated topics, since no match
 * is possible (Requirement 9.7).
 */
function onboardingTopicMatchRatio(
  article: Article,
  onboardingTopicIds: readonly string[],
): number {
  if (article.topics.length === 0) return 0;
  const onboarding = new Set(onboardingTopicIds);
  let matches = 0;
  for (const association of article.topics) {
    if (onboarding.has(association.topicId)) matches++;
  }
  return clamp01(matches / article.topics.length);
}

/**
 * Relevance component in [0, 1].
 *
 * When the user has a usable embedding and the Article is embedded, relevance is
 * the cosine similarity normalized from its native [-1, 1] range onto [0, 1] via
 * `(cos + 1) / 2` (Requirement 9.2). Otherwise it falls back to the onboarding
 * topic-match ratio (Requirement 9.7).
 */
export function relevance(userCtx: UserRankingContext, article: Article): number {
  if (isUsableEmbedding(userCtx.embedding) && isUsableEmbedding(article.embedding)) {
    const cos = cosineSimilarity(userCtx.embedding, article.embedding);
    return clamp01((cos + 1) / 2);
  }
  return onboardingTopicMatchRatio(article, userCtx.onboardingTopicIds);
}

/**
 * Recency component in [0, 1]: exponential decay of article age with a 24-hour
 * half-life, `0.5 ^ (ageHours / 24)`. Yields 1.0 at age 0, 0.5 at 24 hours, and
 * decreases toward 0 as age grows. Ages at or before "now" (non-positive) are
 * clamped to 1.0 (Requirement 9.3).
 */
export function recency(ageHours: number): number {
  if (Number.isNaN(ageHours)) return 0;
  return clamp01(Math.pow(0.5, ageHours / 24));
}

/**
 * Novelty component in [0, 1]: the fraction of the Article's associated topics
 * that the user has not yet engaged with. An Article with no associated topics,
 * or a user who has engaged with nothing, is treated as fully novel (1.0).
 */
export function novelty(article: Article, engagedTopicIds: readonly string[] = []): number {
  if (article.topics.length === 0) return 1;
  const engaged = new Set(engagedTopicIds);
  let unseen = 0;
  for (const association of article.topics) {
    if (!engaged.has(association.topicId)) unseen++;
  }
  return clamp01(unseen / article.topics.length);
}

/**
 * Quality component in [0, 1]: the Article's quality score, clamped defensively
 * into range (the Quality_Scorer already produces a value in [0, 1]).
 */
export function quality(article: Article): number {
  return clamp01(article.qualityScore);
}

/**
 * Diversity bonus in [0, 0.20]. A positive bonus is granted only when the
 * Article's Source has supplied fewer cards in the current session than the
 * average per enabled Source; the more under-represented the Source, the larger
 * the bonus, scaled linearly up to {@link MAX_DIVERSITY_BONUS} (Requirement 9.5).
 */
export function diversityBonus(sourceCardCount: number, avgCardsPerSource: number): number {
  if (!(avgCardsPerSource > 0)) return 0;
  if (sourceCardCount >= avgCardsPerSource) return 0;
  const deficitRatio = (avgCardsPerSource - sourceCardCount) / avgCardsPerSource;
  return clamp(deficitRatio, 0, 1) * MAX_DIVERSITY_BONUS;
}

/**
 * Diversity component in [0, 1]: the under-representation bonus for the
 * Article's Source, capped at 1.0 (Requirement 9.5).
 */
export function diversity(article: Article, sessionCtx: SessionRankingContext): number {
  const sourceCardCount = sessionCtx.sourceCardCounts[article.source] ?? 0;
  return clamp01(diversityBonus(sourceCardCount, sessionCtx.avgCardsPerSource));
}

/**
 * Serendipity component in [0, 1]: the Article's discovery value, defined as the
 * complement of relevance so that content further from the user's established
 * interests scores higher on serendipity. Bounded in [0, 1] because relevance is
 * (Requirement 9.1). The actual selection of a Serendipity_Card — choosing which
 * Article becomes a card — is {@link selectSerendipityArticle} (task 11.7).
 */
export function serendipity(userCtx: UserRankingContext, article: Article): number {
  return clamp01(1 - relevance(userCtx, article));
}

/**
 * Age of `article` in hours relative to the session clock. Negative when the
 * Article's publish time is in the future relative to `nowMs`; {@link recency}
 * clamps such values to 1.0.
 */
function articleAgeHours(article: Article, nowMs: number): number {
  const publishedMs = Date.parse(article.publishedAt);
  if (Number.isNaN(publishedMs)) return 0;
  return (nowMs - publishedMs) / MS_PER_HOUR;
}

/**
 * Computes all six normalized ranking components for an Article, each in
 * [0, 1] (Requirements 9.1, 9.2, 9.3, 9.5, 9.7).
 */
export function computeComponents(
  article: Article,
  userCtx: UserRankingContext,
  sessionCtx: SessionRankingContext,
): RankingComponents {
  const relevanceValue = relevance(userCtx, article);
  return {
    relevance: relevanceValue,
    novelty: novelty(article, userCtx.engagedTopicIds ?? []),
    quality: quality(article),
    recency: recency(articleAgeHours(article, sessionCtx.nowMs)),
    diversity: diversity(article, sessionCtx),
    serendipity: clamp01(1 - relevanceValue),
  };
}

/**
 * Scores a candidate Article as the weighted sum of its six normalized
 * components, clamped to [0, 1] (Requirements 9.1, 9.4). Uses
 * {@link DEFAULT_RANKING_WEIGHTS} unless a `weights` override is supplied.
 */
export function scoreArticle(
  article: Article,
  userCtx: UserRankingContext,
  sessionCtx: SessionRankingContext,
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
): number {
  const c = computeComponents(article, userCtx, sessionCtx);
  const score =
    c.relevance * weights.relevance +
    c.novelty * weights.novelty +
    c.quality * weights.quality +
    c.recency * weights.recency +
    c.diversity * weights.diversity +
    c.serendipity * weights.serendipity;
  return clamp01(score);
}

/**
 * Upper bound of the simplified per-user bandit adjustment applied to the
 * relevance weight for engaged topics (Requirement 9.6).
 */
export const MAX_BANDIT_RELEVANCE_ADJUSTMENT = 0.15;

/**
 * Applies simplified per-user bandit weight tuning and re-normalizes the six
 * component weights so they continue to sum to exactly 1.0 (Requirement 9.6).
 *
 * The caller supplies `relevanceAdjustment`, the simplified bandit boost derived
 * from the topics the user has engaged with. The boost is clamped into the
 * inclusive range [0.0, {@link MAX_BANDIT_RELEVANCE_ADJUSTMENT}] (so a `NaN`,
 * negative, or oversized value is coerced into range) and added to the relevance
 * weight; when the user has engaged with nothing the caller passes `0`, which
 * leaves the relevance weight unchanged before re-normalization. Every weight is
 * then divided by the post-boost total so the result sums to 1.0.
 *
 * The function is pure and total: it never mutates its inputs, and if the
 * post-boost total is not a positive, finite number (a degenerate weight set
 * that cannot be normalized, e.g. all-zero weights with a zero adjustment) it
 * returns an unmodified copy of `weights` rather than producing `NaN`/`Infinity`.
 *
 * @param weights The base component weights to tune (commonly the defaults).
 * @param relevanceAdjustment The simplified bandit boost for engaged topics;
 *   clamped to [0.0, 0.15].
 * @returns A new {@link RankingWeights} whose six weights sum to 1.0.
 */
export function applyBanditTuning(
  weights: RankingWeights,
  relevanceAdjustment: number,
): RankingWeights {
  const boost = clamp(relevanceAdjustment, 0, MAX_BANDIT_RELEVANCE_ADJUSTMENT);
  const boosted: RankingWeights = {
    relevance: weights.relevance + boost,
    novelty: weights.novelty,
    quality: weights.quality,
    recency: weights.recency,
    diversity: weights.diversity,
    serendipity: weights.serendipity,
  };
  const total =
    boosted.relevance +
    boosted.novelty +
    boosted.quality +
    boosted.recency +
    boosted.diversity +
    boosted.serendipity;
  // Guard against division by zero / non-finite totals to stay total.
  if (!Number.isFinite(total) || total <= 0) {
    return { ...weights };
  }
  return {
    relevance: boosted.relevance / total,
    novelty: boosted.novelty / total,
    quality: boosted.quality / total,
    recency: boosted.recency / total,
    diversity: boosted.diversity / total,
    serendipity: boosted.serendipity / total,
  };
}

/**
 * True iff `vector` is a non-empty array of finite numbers. Used to validate
 * the user embedding and topic centroids before computing cosine distances for
 * serendipity selection. Unlike {@link isUsableEmbedding} this does not require
 * a specific width, so the farthest-centroid rule works for any matching-length
 * vectors as long as the user embedding and a centroid agree in length.
 */
function isFiniteVector(vector: readonly number[] | null | undefined): vector is readonly number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.every((n) => Number.isFinite(n));
}

/**
 * Returns the Article with the lexicographically smallest `id`. This makes
 * selection deterministic and independent of the candidate pool's order, which
 * is the tie-break used throughout {@link selectSerendipityArticle}. Assumes a
 * non-empty input.
 */
function pickByLowestId(articles: readonly Article[]): Article {
  let best = articles[0]!;
  for (let i = 1; i < articles.length; i++) {
    const candidate = articles[i]!;
    if (candidate.id < best.id) best = candidate;
  }
  return best;
}

/**
 * Context for selecting a Serendipity_Card (Requirement 10.2, 10.3).
 *
 * The Ranking_Engine performs no I/O, so the caller supplies everything the
 * selection needs: which topics the user has already interacted with, the user
 * embedding, and the per-topic centroids used for the farthest-centroid
 * fallback. This keeps {@link selectSerendipityArticle} pure and total.
 */
export interface SerendipitySelectionContext {
  /**
   * The user's embedding vector, or `null` when no User_Embedding exists yet.
   * Used only by the farthest-centroid fallback (Requirement 10.3); when it is
   * absent or unusable the fallback degrades to a deterministic pick.
   */
  userEmbedding: number[] | null;
  /**
   * The set of Topic ids the user has interacted with — a Topic counts as
   * interacted when the user has any recorded Feed_Event against any associated
   * Article (Requirement 10.2). A Topic absent from this set has never been
   * interacted with.
   */
  interactedTopicIds: readonly string[];
  /**
   * Per-Topic centroid embeddings keyed by Topic id, used to find the Topic
   * whose centroid is farthest from {@link userEmbedding} (Requirement 10.3).
   * A Topic without a usable centroid here (missing, wrong length, or
   * non-finite) is skipped when computing distances. Optional because it is
   * only consulted when no never-interacted Topic exists.
   */
  topicCentroids?: Readonly<Record<string, readonly number[] | null | undefined>>;
}

/**
 * Selects the Article to present as a Serendipity_Card from `candidatePool`,
 * following the never-interacted-then-farthest rule (Requirements 10.2, 10.3).
 *
 * The selection proceeds in two phases:
 *
 * 1. **Never-interacted Topic (Requirement 10.2).** If any candidate is
 *    associated with a Topic the user has never interacted with (a Topic absent
 *    from {@link SerendipitySelectionContext.interactedTopicIds}), the selection
 *    is drawn from those candidates. Candidates whose topics are *entirely*
 *    outside the interacted set are preferred over candidates that merely
 *    include a never-interacted Topic alongside an interacted one. An Article
 *    with no topic associations belongs to no Topic and therefore never
 *    qualifies for this phase.
 * 2. **Farthest centroid (Requirement 10.3).** If no candidate is associated
 *    with a never-interacted Topic, the selection is drawn from the Topic
 *    (present in the pool and equipped with a usable centroid) whose centroid is
 *    farthest — lowest cosine similarity — from the user embedding.
 *
 * The function is pure and total. It never mutates its inputs and always returns
 * within range:
 * - Returns `null` when `candidatePool` is empty.
 * - Falls back to a deterministic pick across the whole pool when the
 *   farthest-centroid rule cannot be applied (no user embedding, or no candidate
 *   Topic has a usable centroid), so it never returns `null` for a non-empty
 *   pool.
 *
 * All tie-breaking is deterministic and independent of input order: ties between
 * Topics are broken by the lexicographically smallest Topic id, and ties between
 * Articles by the lexicographically smallest Article id.
 *
 * @param ctx The serendipity selection context (interacted topics, user
 *   embedding, and per-topic centroids).
 * @param candidatePool The Articles eligible to become the Serendipity_Card.
 * @returns The selected Article, or `null` when the pool is empty.
 */
export function selectSerendipityArticle(
  ctx: SerendipitySelectionContext,
  candidatePool: readonly Article[],
): Article | null {
  if (candidatePool.length === 0) return null;

  const interacted = new Set(ctx.interactedTopicIds);

  // Phase 1 — never-interacted Topic (Requirement 10.2). A candidate qualifies
  // when at least one of its associated topics has never been interacted with.
  const qualifying = candidatePool.filter((article) =>
    article.topics.some((association) => !interacted.has(association.topicId)),
  );
  if (qualifying.length > 0) {
    // Prefer candidates whose topics are *entirely* outside the interacted set.
    const entirelyOutside = qualifying.filter((article) =>
      article.topics.every((association) => !interacted.has(association.topicId)),
    );
    const preferred = entirelyOutside.length > 0 ? entirelyOutside : qualifying;
    return pickByLowestId(preferred);
  }

  // Phase 2 — farthest centroid (Requirement 10.3). Find the Topic present in
  // the pool whose centroid is farthest (lowest cosine similarity) from the
  // user embedding, then select an Article associated with that Topic.
  const userEmbedding = ctx.userEmbedding;
  const centroids = ctx.topicCentroids ?? {};
  if (isFiniteVector(userEmbedding)) {
    const poolTopicIds = new Set<string>();
    for (const article of candidatePool) {
      for (const association of article.topics) poolTopicIds.add(association.topicId);
    }

    let farthestTopicId: string | null = null;
    let lowestSimilarity = Number.POSITIVE_INFINITY;
    // Iterate topic ids in ascending order so equal-similarity ties resolve to
    // the lexicographically smallest Topic id (strict `<` keeps the earlier one).
    for (const topicId of [...poolTopicIds].sort()) {
      const centroid = centroids[topicId];
      if (!isFiniteVector(centroid) || centroid.length !== userEmbedding.length) continue;
      const similarity = cosineSimilarity(userEmbedding, centroid);
      if (similarity < lowestSimilarity) {
        lowestSimilarity = similarity;
        farthestTopicId = topicId;
      }
    }

    if (farthestTopicId !== null) {
      const inFarthestTopic = candidatePool.filter((article) =>
        article.topics.some((association) => association.topicId === farthestTopicId),
      );
      if (inFarthestTopic.length > 0) return pickByLowestId(inFarthestTopic);
    }
  }

  // Total fallback: no never-interacted Topic and no usable centroid distance
  // could be computed. Pick deterministically across the whole pool.
  return pickByLowestId(candidatePool);
}

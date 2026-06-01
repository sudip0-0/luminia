// Preference_Model_Updater — topic-weight recomputation and emerging-topic
// detection. (Requirements 14.6, 14.7, 14.8; Properties 31, 32.)
//
// After the User_Embedding is recomputed (see ./centroid.ts), the
// Preference_Model_Updater derives two further outputs from the user's recent
// activity:
//
//  1. A weight for every Topic, measuring how aligned the new User_Embedding is
//     with that Topic's centroid (Requirement 14.6, Property 31).
//  2. The set of *emerging* Topics — those whose interest signal is growing
//     sharply week-over-week (Requirements 14.7, 14.8, Property 32).
//
// Both functions are pure, deterministic, and total: they read only their
// arguments, never mutate them, never touch the clock or any external state,
// and always return a well-defined result for arbitrary input. Persisting the
// results is the caller's responsibility (a later task). The per-event interest
// signal is reused from ./signal-weights.ts via {@link eventSignal} so the
// weighting lives in a single source of truth.

import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import { eventSignal, type SignalEvent } from './signal-weights.js';

/** Inclusive lower bound a recomputed topic weight is clamped to (Requirement 14.6). */
export const MIN_TOPIC_WEIGHT = 0.0;

/** Inclusive upper bound a recomputed topic weight is clamped to (Requirement 14.6). */
export const MAX_TOPIC_WEIGHT = 2.0;

/** Milliseconds in one 7-day trend window (Requirements 14.7, 14.8). */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Growth factor for emerging-topic classification: the most-recent-7-day signal
 * must exceed `EMERGING_GROWTH_FACTOR ×` the preceding-7-day signal — i.e. be at
 * least 20% larger — for a topic to be emerging (Requirement 14.7, Property 32).
 */
export const EMERGING_GROWTH_FACTOR = 1.2;

/**
 * Clamp a recomputed topic weight to the inclusive range
 * [{@link MIN_TOPIC_WEIGHT}, {@link MAX_TOPIC_WEIGHT}] = [0.0, 2.0]
 * (Requirement 14.6, Property 31). `NaN` maps to the lower bound so the result
 * is always a finite number in range.
 */
export function clampTopicWeight(value: number): number {
  if (Number.isNaN(value)) return MIN_TOPIC_WEIGHT;
  if (value < MIN_TOPIC_WEIGHT) return MIN_TOPIC_WEIGHT;
  if (value > MAX_TOPIC_WEIGHT) return MAX_TOPIC_WEIGHT;
  return value;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1]. Returns 0 when the
 * vectors differ in length, when either has zero magnitude, or when the result
 * is non-finite — matching the neutral-similarity convention used elsewhere in
 * the codebase (the Ranking_Engine's relevance computation).
 */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  const result = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  return Number.isFinite(result) ? result : 0;
}

/** True iff `vector` is a usable embedding of {@link EMBEDDING_DIMENSIONS} finite numbers. */
function isFullWidthEmbedding(
  vector: readonly number[] | null | undefined,
): vector is readonly number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Recompute each Topic's weight from the recomputed User_Embedding
 * (Requirement 14.6, Property 31).
 *
 * For every Topic, the weight is the cosine similarity between the
 * User_Embedding and that Topic's centroid, clamped to [0.0, 2.0]:
 *
 *     weight(topic) = clamp( cosine(userEmbedding, topicCentroid), 0.0, 2.0 )
 *
 * Cosine similarity is mathematically bounded to [-1, 1], so in practice the
 * lower clamp turns any non-positive similarity into 0.0 (a Topic the user is
 * not aligned with carries no weight) while a perfect alignment yields 1.0; the
 * 2.0 upper bound is the inclusive ceiling mandated by the requirement. This is
 * exactly the mapping in design Property 31.
 *
 * Robustness: if the `userEmbedding` is not a usable {@link EMBEDDING_DIMENSIONS}
 * -wide finite vector, no meaningful similarity exists, so every Topic is
 * assigned weight 0.0. Likewise, any Topic whose centroid is not a usable
 * full-width vector is assigned weight 0.0. A weight is returned for *every*
 * Topic key supplied in `topicCentroids`.
 *
 * Pure and deterministic: identical inputs always yield identical output.
 */
export function recomputeTopicWeights(
  userEmbedding: readonly number[],
  topicCentroids: ReadonlyMap<string, readonly number[]>,
): Map<string, number> {
  const weights = new Map<string, number>();
  const userUsable = isFullWidthEmbedding(userEmbedding);
  for (const [topicId, centroid] of topicCentroids) {
    if (!userUsable || !isFullWidthEmbedding(centroid)) {
      weights.set(topicId, MIN_TOPIC_WEIGHT);
      continue;
    }
    weights.set(topicId, clampTopicWeight(cosineSimilarity(userEmbedding, centroid)));
  }
  return weights;
}

/**
 * The emerging-topic growth rule (Requirement 14.7, Property 32).
 *
 * A Topic is emerging if and only if its most-recent-7-day aggregate signal `r`
 * exceeds `EMERGING_GROWTH_FACTOR ×` its preceding-7-day aggregate signal `p`
 * (a strict >= 20% increase), OR its preceding-7-day signal is non-positive
 * (`p <= 0`) while its most-recent-7-day signal is strictly positive (`r > 0`).
 * The second clause captures interest appearing from a flat or declining base,
 * where a percentage-growth comparison is not meaningful.
 *
 * The strict inequality `r > 1.2·p` matches design Property 32 exactly: a Topic
 * sitting precisely on the threshold (`r === 1.2·p`) is *not* emerging.
 */
export function isTopicEmerging(recentSignal: number, precedingSignal: number): boolean {
  return (
    recentSignal > EMERGING_GROWTH_FACTOR * precedingSignal ||
    (precedingSignal <= 0 && recentSignal > 0)
  );
}

/**
 * A Feed_Event scoped to a Topic and timestamped, as consumed by
 * {@link detectEmergingTopics}. Carries the event `type`/`payload` understood by
 * {@link eventSignal}, the `topicId` the event is attributed to (`null` for an
 * event with no Topic association, which contributes no per-topic signal), and
 * the occurrence time as epoch milliseconds.
 */
export interface TopicTimedEvent extends SignalEvent {
  /** Target Topic, or `null` for an event not associated with a Topic. */
  topicId: string | null;
  /** Occurrence time as epoch milliseconds (UTC). */
  occurredAtMs: number;
}

/**
 * Detect the user's emerging Topics by comparing the most-recent 7 days of
 * activity with the preceding 7 days (Requirements 14.7, 14.8; Property 32).
 *
 * Two contiguous, non-overlapping windows are measured relative to `nowMs`
 * (the run's start time):
 *   - recent:    `(nowMs - 7d, nowMs]`
 *   - preceding: `(nowMs - 14d, nowMs - 7d]`
 * The half-open boundaries guarantee every event falls in at most one window,
 * so no signal is double-counted; events outside both windows (older than 14
 * days or in the future relative to `nowMs`) and events with a non-finite
 * timestamp are ignored.
 *
 * For each Topic, the aggregate signal `r` (recent) and `p` (preceding) are the
 * sums of {@link eventSignal} over that Topic's events in the respective window.
 * A Topic is emerging exactly when {@link isTopicEmerging}(`r`, `p`) holds.
 *
 * Requirement 14.8: if the user has *no* Feed_Events in either window — even
 * events with no Topic association count here — no Topic can be emerging, so the
 * result is an empty list.
 *
 * Returns the emerging Topic ids sorted ascending for deterministic output.
 * Pure and deterministic: it reads only its arguments.
 */
export function detectEmergingTopics(
  events: readonly TopicTimedEvent[],
  nowMs: number,
): string[] {
  const recentStartMs = nowMs - SEVEN_DAYS_MS;
  const precedingStartMs = nowMs - 2 * SEVEN_DAYS_MS;

  // Per-topic accumulated interest signal for each window.
  const recentByTopic = new Map<string, number>();
  const precedingByTopic = new Map<string, number>();
  // Count of Feed_Events landing in either window (Requirement 14.8 emptiness
  // test) — independent of whether the event is attributed to a Topic.
  let eventsInEitherWindow = 0;

  for (const event of events) {
    const occurredAtMs = event.occurredAtMs;
    if (!Number.isFinite(occurredAtMs)) continue;

    let target: Map<string, number> | null = null;
    if (occurredAtMs > recentStartMs && occurredAtMs <= nowMs) {
      target = recentByTopic;
    } else if (occurredAtMs > precedingStartMs && occurredAtMs <= recentStartMs) {
      target = precedingByTopic;
    } else {
      continue; // outside both 7-day windows
    }

    eventsInEitherWindow += 1;

    const topicId = event.topicId;
    if (topicId === null || topicId === undefined) continue;
    target.set(topicId, (target.get(topicId) ?? 0) + eventSignal(event));
  }

  // Requirement 14.8: no events in BOTH 7-day windows ⇒ no emerging topics.
  if (eventsInEitherWindow === 0) return [];

  const emerging: string[] = [];
  const topicIds = new Set<string>([...recentByTopic.keys(), ...precedingByTopic.keys()]);
  for (const topicId of topicIds) {
    const recentSignal = recentByTopic.get(topicId) ?? 0;
    const precedingSignal = precedingByTopic.get(topicId) ?? 0;
    if (isTopicEmerging(recentSignal, precedingSignal)) {
      emerging.push(topicId);
    }
  }
  emerging.sort();
  return emerging;
}

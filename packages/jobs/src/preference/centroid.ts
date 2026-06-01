// Preference_Model_Updater — recency-weighted centroid embedding update.
// (Requirements 14.2, 14.4, 14.5, 14.9; Properties 30, 33.)
//
// Every 6 hours the Preference_Model_Updater recomputes a user's User_Embedding
// from the Feed_Events recorded in the trailing 30-day window that ends at the
// run's start time (Requirement 14.2). The new embedding is the *recency-
// weighted centroid* of the embeddings of the user's "engaged" articles — those
// whose net weighted interest signal over the window is strictly greater than
// 0.0 (Requirement 14.4). When the window contains no events the model is left
// unchanged (Requirement 14.9).
//
// These functions are pure, deterministic, and side-effect free: persistence of
// the recomputed embedding is the caller's responsibility (a later task). They
// reuse the event-type signal weighting from ./signal-weights.ts via
// {@link eventSignal} so the per-article net signal is computed exactly once,
// from a single source of truth.
//
// Recency-weight design (Requirement 14.5):
//   Each engaged article's contribution to the centroid is
//       weight = netSignal × recencyWeight(mostRecentEventTime)
//   where `recencyWeight` is an exponential decay of the article's *most recent*
//   Feed_Event age, `0.5 ^ (age / RECENCY_HALF_LIFE_MS)`. Because that decay is
//   strictly positive and strictly increasing in the most-recent-event time
//   (older ⇒ smaller, newer ⇒ larger), two engaged articles with *equal* net
//   signal receive weights whose ordering is decided entirely by recency: the
//   one whose most recent Feed_Event occurred later contributes a strictly
//   greater weight. This satisfies the strict tie-break of Requirement 14.5.

import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import { eventSignal, type SignalEvent } from './signal-weights.js';

/** Milliseconds in the 30-day evaluation window (Requirement 14.2). */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Half-life of the recency weight, in milliseconds (7 days).
 *
 * A deliberately short half-life relative to the 30-day window biases the
 * centroid toward recently engaged articles while still letting every engaged
 * article contribute a strictly positive weight. Its exact value does not
 * affect correctness of the strict tie-break (Requirement 14.5) — only that the
 * decay is strictly positive and strictly increasing in the most-recent-event
 * time — but it is fixed here so the computation is fully deterministic.
 */
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A Feed_Event carrying everything the centroid update needs: the event `type`
 * and optional `payload` (consumed by {@link eventSignal}), the `articleId` it
 * targets (events with a `null` target — e.g. `session_end` — are ignored for
 * per-article grouping), and the occurrence time as epoch milliseconds.
 */
export interface TimedSignalEvent extends SignalEvent {
  /** Target article, or `null` for events without an article (e.g. session_end). */
  articleId: string | null;
  /** Occurrence time as epoch milliseconds (UTC). */
  occurredAtMs: number;
}

/**
 * Result of recomputing the User_Embedding.
 *
 * - `unchanged`: the model must be left exactly as it was. `reason` is
 *   `empty-window` when the 30-day window held no events (Requirement 14.9) and
 *   `no-engaged-articles` when events existed but no article had both a net
 *   signal > 0 and a usable embedding (no meaningful centroid can be formed).
 * - `updated`: carries the new {@link EMBEDDING_DIMENSIONS}-wide centroid.
 */
export type EmbeddingUpdate =
  | { status: 'unchanged'; reason: 'empty-window' | 'no-engaged-articles' }
  | { status: 'updated'; embedding: number[] };

/** True iff `vector` is a usable embedding of {@link EMBEDDING_DIMENSIONS} finite numbers. */
export function isUsableEmbedding(
  vector: readonly number[] | null | undefined,
): vector is readonly number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Keep only the events that fall within the trailing 30-day window that ends at
 * `windowEndMs` (the run's start time), i.e. those with
 * `windowEndMs - windowMs <= occurredAtMs <= windowEndMs` (Requirement 14.2).
 *
 * Events with a non-finite `occurredAtMs`, events older than the window start,
 * and events in the future relative to `windowEndMs` are all excluded. Pure and
 * total — returns a new array and never throws.
 */
export function eventsInWindow<T extends { occurredAtMs: number }>(
  events: readonly T[],
  windowEndMs: number,
  windowMs: number = THIRTY_DAYS_MS,
): T[] {
  const windowStartMs = windowEndMs - windowMs;
  return events.filter(
    (event) =>
      Number.isFinite(event.occurredAtMs) &&
      event.occurredAtMs >= windowStartMs &&
      event.occurredAtMs <= windowEndMs,
  );
}

/**
 * Recency weight for an article from its most-recent Feed_Event time, relative
 * to the window end: `0.5 ^ (age / halfLifeMs)` where `age = windowEndMs -
 * mostRecentMs` (clamped at 0 for any event at/after the window end).
 *
 * The result is always strictly positive and, for `mostRecentMs <= windowEndMs`,
 * strictly increasing in `mostRecentMs`: a later most-recent event yields a
 * strictly greater weight. This is the mechanism behind the Requirement 14.5
 * tie-break.
 */
export function recencyWeight(
  mostRecentMs: number,
  windowEndMs: number,
  halfLifeMs: number = RECENCY_HALF_LIFE_MS,
): number {
  const ageMs = windowEndMs - mostRecentMs;
  const age = ageMs > 0 ? ageMs : 0;
  return Math.pow(0.5, age / halfLifeMs);
}

/** Per-article aggregate over the window: net interest signal and most-recent event time. */
interface ArticleAggregate {
  /** Net weighted interest signal over the window (engaged iff > 0). */
  netSignal: number;
  /** Latest `occurredAtMs` among the article's in-window events. */
  mostRecentMs: number;
}

/**
 * Group in-window events by `articleId`, summing each article's net interest
 * signal (via {@link eventSignal}) and tracking the most-recent event time.
 * Events with a `null`/`undefined` `articleId` are skipped.
 */
function aggregateByArticle(events: readonly TimedSignalEvent[]): Map<string, ArticleAggregate> {
  const byArticle = new Map<string, ArticleAggregate>();
  for (const event of events) {
    const articleId = event.articleId;
    if (articleId === null || articleId === undefined) continue;
    const signal = eventSignal(event);
    const existing = byArticle.get(articleId);
    if (existing === undefined) {
      byArticle.set(articleId, { netSignal: signal, mostRecentMs: event.occurredAtMs });
    } else {
      existing.netSignal += signal;
      if (event.occurredAtMs > existing.mostRecentMs) {
        existing.mostRecentMs = event.occurredAtMs;
      }
    }
  }
  return byArticle;
}

/**
 * Recompute the User_Embedding as the recency-weighted centroid of the user's
 * engaged articles over the trailing 30-day window
 * (Requirements 14.2, 14.4, 14.5, 14.9; Properties 30, 33).
 *
 * Steps:
 *  1. Restrict `events` to the 30-day window ending at `nowMs` (the run start).
 *     An empty window is a no-op (`unchanged`/`empty-window`, Requirement 14.9).
 *  2. Group the windowed events by article, computing each article's net
 *     weighted signal and most-recent event time. An article is *engaged* iff
 *     its net signal is strictly greater than 0.0 (Requirement 14.4).
 *  3. Of the engaged articles, keep those for which a usable
 *     {@link EMBEDDING_DIMENSIONS}-wide embedding is available in
 *     `articleEmbeddings`. If none remain, the model is left unchanged
 *     (`unchanged`/`no-engaged-articles`).
 *  4. Combine the engaged embeddings into a weighted centroid where each
 *     article's weight is `netSignal × recencyWeight(mostRecentMs)` — strictly
 *     positive, so the centroid is a true weighted average, and strictly
 *     increasing in recency for equal net signal (Requirement 14.5).
 *
 * Pure and deterministic: it neither reads nor persists state. `nowMs` is the
 * execution start time of the run, in epoch milliseconds.
 */
export function computeUserEmbedding(
  events: readonly TimedSignalEvent[],
  articleEmbeddings: ReadonlyMap<string, readonly number[]>,
  nowMs: number,
  options: { halfLifeMs?: number; windowMs?: number } = {},
): EmbeddingUpdate {
  const { halfLifeMs = RECENCY_HALF_LIFE_MS, windowMs = THIRTY_DAYS_MS } = options;

  const windowed = eventsInWindow(events, nowMs, windowMs);
  if (windowed.length === 0) {
    return { status: 'unchanged', reason: 'empty-window' };
  }

  const byArticle = aggregateByArticle(windowed);

  // Accumulate the weighted sum of engaged-article embeddings and the total
  // weight, so the centroid is sum(weight × embedding) / sum(weight).
  const acc = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  let totalWeight = 0;

  for (const [articleId, aggregate] of byArticle) {
    if (aggregate.netSignal <= 0) continue; // not engaged (Requirement 14.4)
    const embedding = articleEmbeddings.get(articleId);
    if (!isUsableEmbedding(embedding)) continue; // no usable vector to contribute

    const weight = aggregate.netSignal * recencyWeight(aggregate.mostRecentMs, nowMs, halfLifeMs);
    if (!(weight > 0)) continue; // defensive: ignore non-positive/non-finite weights

    totalWeight += weight;
    for (let d = 0; d < EMBEDDING_DIMENSIONS; d++) {
      acc[d] = (acc[d] ?? 0) + weight * (embedding[d] ?? 0);
    }
  }

  if (totalWeight <= 0) {
    return { status: 'unchanged', reason: 'no-engaged-articles' };
  }

  const embedding = acc.map((sum) => sum / totalWeight);
  return { status: 'updated', embedding };
}

// Insights_Service — topic interest breakdown (trend-classified, weight-ordered)
// and the current topic-weights endpoint.
//
// Implements two pieces of the design's Insights_Service (Requirements 24.2,
// 25.1):
//   - getTopicBreakdown: the per-topic interest breakdown sorted by descending
//     weight, labelling each Topic `growing` | `fading` | `steady` from the
//     change in its aggregate behaviour signal over the most recent 7 days
//     versus the preceding 7 days, and carrying each topic's current weight
//     (Requirement 24.2, the GET /insights topic breakdown).
//   - getTopicWeights: each Topic associated with the user, its current weight,
//     and whether it is currently muted, sorted by descending weight
//     (Requirement 25.1, GET /topics/weights).
//
// Trend thresholds (documented, per Requirement 24.2): with `prior` the
// aggregate signal over the preceding 7 days and `recent` the aggregate signal
// over the most recent 7 days, a topic is
//   - `growing` when the 7-day signal increased by MORE than 10%,
//   - `fading`  when it decreased by MORE than 10%,
//   - `steady`  when it changed within ±10% (the ±10% endpoints are steady).
// When `prior <= 0` a percentage change is undefined, so — consistent with the
// growth wording used by the Preference_Model_Updater's emerging-topic rule
// (Requirement 14.7, where a non-positive prior with a positive recent counts
// as growth) — the topic is classified purely by the direction of the change:
// `growing` when `recent > prior`, `fading` when `recent < prior`, else
// `steady`. A topic with no signal in either window is therefore `steady`.
//
// Signal weighting mirrors the Preference_Model_Updater's per-event-type
// weights (Requirement 14.3). It is reproduced locally here rather than imported
// from the jobs tier so the API package keeps its narrow dependency surface
// (it depends only on `@lumina/shared`, never on `@lumina/jobs`). A topic's
// aggregate signal in a window is the sum of the signal weights of the user's
// events in that window that touch the topic — either directly (an event whose
// `topicId` is the topic) or via an article associated with the topic.
//
// DB access stays behind the repository layer over the narrow `Queryable`
// interface, so both functions are fully unit-testable with an in-memory
// `FakeQueryable`; the 7-day aggregates are computed in code from the queried
// events.

import type { FeedEventType } from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import { listUserTopics } from '../repositories/user-topics.repository.js';
import { listFeedEventsInWindow } from '../repositories/feed-events.repository.js';
import { listTopicIdsForArticles } from '../repositories/article-topics.repository.js';
import type { FeedEventRecord } from '../repositories/types.js';

/** Milliseconds in seven days, the width of each comparison window. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fractional change threshold for the trend labels (Requirement 24.2). A change
 * strictly greater than this is `growing`/`fading`; a change within ±this
 * (inclusive) is `steady`.
 */
const TREND_THRESHOLD = 0.1;

/**
 * Per-event-type interest-signal weights, mirroring the Preference_Model_Updater
 * (Requirement 14.3). Every type contributes its fixed weight except
 * `scroll_depth`, whose weight is the coefficient scaled by the recorded scroll
 * proportion (see {@link eventSignal}).
 */
const EVENT_TYPE_WEIGHTS: Readonly<Record<FeedEventType, number>> = {
  impression: 0.05,
  dwell: 0.15,
  expand: 0.35,
  scroll_depth: 0.1,
  save: 0.5,
  unsave: 0.0,
  share: 0.6,
  link_out: 0.45,
  skip: -0.2,
  session_end: 0.0,
  mute_topic: -1.0,
};

/** A topic's interest trend relative to the preceding 7 days. */
export type TopicTrend = 'growing' | 'fading' | 'steady';

/** One row of the per-topic interest breakdown (Requirement 24.2). */
export interface TopicBreakdownEntry {
  /** The topic this entry describes. */
  topicId: string;
  /** The topic's current interest weight. */
  weight: number;
  /** The 7-day trend label for the topic. */
  trend: TopicTrend;
}

/** One row of the topic-weights response (Requirement 25.1). */
export interface TopicWeightEntry {
  /** The topic associated with the user. */
  topicId: string;
  /** The topic's current interest weight. */
  weight: number;
  /** Whether the topic is currently muted. */
  muted: boolean;
}

/** Dependencies for the topic-insights functions: only a database handle. */
export interface TopicInsightsDeps {
  /** The database handle (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
}

/**
 * Read the clamped scroll proportion from a `scroll_depth` payload. A missing
 * payload, missing field, or non-finite value is treated as 0; values are
 * clamped to [0, 1].
 */
function readScrollProportion(payload: Record<string, unknown>): number {
  const raw = payload.scrollProportion;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * The interest signal a single Feed_Event contributes (Requirement 14.3).
 * `scroll_depth` scales its coefficient by the clamped scroll proportion; every
 * other type contributes its fixed weight.
 */
export function eventSignal(event: FeedEventRecord): number {
  const weight = EVENT_TYPE_WEIGHTS[event.type];
  if (event.type === 'scroll_depth') {
    return weight * readScrollProportion(event.payload);
  }
  return weight;
}

/**
 * Classify a topic's trend from its aggregate signal over the most recent 7
 * days (`recent`) versus the preceding 7 days (`prior`) (Requirement 24.2).
 *
 * When `prior > 0` the relative change is well-defined and compared against
 * ±{@link TREND_THRESHOLD}: a change of more than +10% is `growing`, more than
 * -10% is `fading`, and anything within ±10% (inclusive of the endpoints) is
 * `steady`. When `prior <= 0` the percentage is undefined, so the label follows
 * the direction of the change (`growing` if it rose, `fading` if it fell, else
 * `steady`), consistent with the growth wording of Requirement 14.7.
 */
export function classifyTrend(
  recent: number,
  prior: number,
  threshold = TREND_THRESHOLD,
): TopicTrend {
  if (prior > 0) {
    // Compare against scaled bounds rather than a divided ratio so the ±10%
    // endpoints classify as `steady` without floating-point drift.
    if (recent > prior * (1 + threshold)) return 'growing';
    if (recent < prior * (1 - threshold)) return 'fading';
    return 'steady';
  }
  if (recent > prior) return 'growing';
  if (recent < prior) return 'fading';
  return 'steady';
}

/** Aggregate signal per topic, split into the recent and prior 7-day windows. */
interface TopicSignalWindows {
  recent: Map<string, number>;
  prior: Map<string, number>;
}

/**
 * Aggregate each event's signal into per-topic recent/prior buckets. An event
 * contributes to a topic when its `topicId` is the topic, or when it targets an
 * article associated with the topic (an article may map to several topics, in
 * which case the event's signal is counted for each). `nowMs` anchors the two
 * adjacent 7-day windows: recent is `[nowMs-7d, nowMs)`, prior is
 * `[nowMs-14d, nowMs-7d)`. Events outside both windows are ignored.
 */
function aggregateTopicSignals(
  events: readonly FeedEventRecord[],
  topicsByArticleId: ReadonlyMap<string, readonly string[]>,
  nowMs: number,
): TopicSignalWindows {
  const recentStartMs = nowMs - SEVEN_DAYS_MS;
  const priorStartMs = nowMs - 2 * SEVEN_DAYS_MS;
  const recent = new Map<string, number>();
  const prior = new Map<string, number>();

  for (const event of events) {
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs) || occurredMs < priorStartMs || occurredMs >= nowMs) {
      continue;
    }
    const bucket = occurredMs >= recentStartMs ? recent : prior;

    const topicIds = new Set<string>();
    if (event.topicId != null) topicIds.add(event.topicId);
    if (event.articleId != null) {
      for (const topicId of topicsByArticleId.get(event.articleId) ?? []) {
        topicIds.add(topicId);
      }
    }
    if (topicIds.size === 0) continue;

    const signal = eventSignal(event);
    for (const topicId of topicIds) {
      bucket.set(topicId, (bucket.get(topicId) ?? 0) + signal);
    }
  }

  return { recent, prior };
}

/** Distinct, non-null article ids referenced by a set of events. */
function distinctArticleIds(events: readonly FeedEventRecord[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.articleId != null) ids.add(event.articleId);
  }
  return [...ids];
}

/**
 * Compute a user's per-topic interest breakdown at `nowMs` (Requirement 24.2).
 *
 * Returns the user's topics sorted by descending weight (ties broken by topic
 * id, matching the repository order), each carrying its current weight and a
 * `growing` | `fading` | `steady` trend label derived from the change in its
 * aggregate behaviour signal across the two adjacent 7-day windows. A user with
 * no topics yields an empty array; topics with no signal in either window are
 * `steady`.
 */
export async function getTopicBreakdown(
  deps: TopicInsightsDeps,
  userId: string,
  nowMs: number,
): Promise<TopicBreakdownEntry[]> {
  const { db } = deps;

  const userTopics = await listUserTopics(db, userId);
  if (userTopics.length === 0) return [];

  // Events across both 7-day windows: [nowMs-14d, nowMs).
  const windowStartIso = new Date(nowMs - 2 * SEVEN_DAYS_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const events = await listFeedEventsInWindow(db, userId, {
    from: windowStartIso,
    to: nowIso,
  });

  // Resolve article -> topics for every article referenced by these events.
  const articleIds = distinctArticleIds(events);
  const associations = await listTopicIdsForArticles(db, articleIds);
  const topicsByArticleId = new Map<string, string[]>();
  for (const assoc of associations) {
    const existing = topicsByArticleId.get(assoc.articleId);
    if (existing) existing.push(assoc.topicId);
    else topicsByArticleId.set(assoc.articleId, [assoc.topicId]);
  }

  const { recent, prior } = aggregateTopicSignals(events, topicsByArticleId, nowMs);

  // listUserTopics already orders by descending weight, then topic id.
  return userTopics.map((topic) => ({
    topicId: topic.topicId,
    weight: topic.weight,
    trend: classifyTrend(recent.get(topic.topicId) ?? 0, prior.get(topic.topicId) ?? 0),
  }));
}

/**
 * Return each Topic associated with the user, its current weight, and whether
 * it is currently muted, sorted by descending weight (Requirement 25.1, the
 * GET /topics/weights endpoint). Ties break by topic id, matching the
 * repository order. A user with no topics yields an empty array.
 */
export async function getTopicWeights(
  deps: TopicInsightsDeps,
  userId: string,
): Promise<TopicWeightEntry[]> {
  const { db } = deps;
  const userTopics = await listUserTopics(db, userId);
  return userTopics.map((topic) => ({
    topicId: topic.topicId,
    weight: topic.weight,
    muted: topic.muted,
  }));
}

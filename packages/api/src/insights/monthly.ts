// Insights_Service — monthly aggregates and per-source reading-time breakdown.
//
// Implements the design's Insights_Service monthly statistics (Requirements
// 24.1, 24.3, 24.8):
//   - the count of articles read in the current calendar month (24.1)
//   - the total quality reading time in whole minutes for the month, EXCLUDING
//     skip events (24.1, 24.3)
//   - the count of newly discovered topics first engaged in the month (24.1)
//   - a per-source reading-time breakdown in whole minutes for the month (24.3)
//   - zero counts and an empty breakdown when the user has no reading history
//     (24.8)
//
// Window choice (documented): aggregates cover the CURRENT CALENDAR MONTH in
// UTC, anchored at the supplied `nowMs`. The month runs from the first instant
// of the month (inclusive) to the first instant of the next month (exclusive),
// matching the "current calendar month" wording of Requirement 24.1 rather than
// a trailing 30-day window.
//
// What counts as "reading": the Signal_Collector emits exactly one `dwell`
// Feed_Event carrying the tracked duration when a card was viewed for >=1500ms,
// and a `skip` Feed_Event when a card left the viewport in <1500ms
// (Requirements 12.4, 12.5). Quality reading therefore derives solely from
// `dwell` events' `dwellMs` payload; `skip` events are explicitly excluded from
// the reading-time sum (Requirement 24.3). An article is "read" when it has at
// least one `dwell` event in the month, and a topic is "newly discovered" when
// its earliest `dwell` (across the user's full history) falls in the month.
//
// The aggregation is a pure function (`computeMonthlyInsights`) fed by rows the
// thin orchestrator (`getMonthlyInsights`) queries through the repository layer
// over the narrow `Queryable` interface, so the logic is fully unit-testable
// with an in-memory `FakeQueryable` and never opens a live connection. Counts
// are derived in code from queried event/article rows rather than via complex
// aggregate SQL, per the task's guidance.

import type { Source } from '@lumina/shared';
import type { Queryable } from '../repositories/queryable.js';
import { listFeedEventsInWindow } from '../repositories/feed-events.repository.js';
import { findArticleById } from '../repositories/articles.repository.js';
import { listTopicIdsForArticles } from '../repositories/article-topics.repository.js';
import type { FeedEventRecord } from '../repositories/types.js';

/** Milliseconds in one whole minute, used to convert reading time to minutes. */
const MS_PER_MINUTE = 60_000;

/** The earliest possible window lower bound for the full-history dwell query. */
const EPOCH_ISO = new Date(0).toISOString();

/** Reading time attributed to a single Source for the month, in whole minutes. */
export interface SourceReadingTime {
  source: Source;
  /** Whole minutes of quality reading attributed to this source (floored). */
  minutes: number;
}

/**
 * The monthly insights aggregates for a user (Requirements 24.1, 24.3). All
 * counts are zero and {@link readingTimeBySource} is empty when the user has no
 * reading history in the month (Requirement 24.8).
 */
export interface MonthlyInsights {
  /** The calendar month covered, as `YYYY-MM` in UTC. */
  month: string;
  /** Distinct articles read (>=1 dwell event) in the month (Requirement 24.1). */
  articlesRead: number;
  /**
   * Whole minutes of quality reading in the month, excluding skip events
   * (Requirements 24.1, 24.3). Floored from the summed dwell milliseconds.
   */
  qualityReadingMinutes: number;
  /**
   * Distinct topics first engaged (first dwell across all history) in the month
   * (Requirement 24.1).
   */
  newlyDiscoveredTopics: number;
  /**
   * Reading minutes grouped by Source for the month (Requirement 24.3), ordered
   * by descending minutes then source. Sources contributing less than one whole
   * minute are omitted; the array is empty with no reading history
   * (Requirement 24.8).
   */
  readingTimeBySource: SourceReadingTime[];
}

/** Dependencies for {@link getMonthlyInsights}: only a database handle. */
export interface MonthlyInsightsDeps {
  /** The database handle (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
}

/** Resolved bounds of the calendar month containing `nowMs` (UTC). */
interface MonthBounds {
  /** First instant of the month, inclusive (epoch ms). */
  startMs: number;
  /** Inclusive ISO lower bound. */
  startIso: string;
  /** Exclusive ISO upper bound (first instant of the next month). */
  endIso: string;
  /** The month label, `YYYY-MM`. */
  label: string;
}

/**
 * Compute the UTC calendar-month bounds containing `nowMs`. The upper bound is
 * the first instant of the next month (exclusive), correctly rolling over at
 * year boundaries via `Date.UTC(year, month + 1, 1)`.
 */
export function monthBounds(nowMs: number): MonthBounds {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  const label = `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    startMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    label,
  };
}

/**
 * Extract the reading milliseconds an event contributes. Only `dwell` events
 * carry a `dwellMs` payload; any non-numeric, missing, or non-positive value
 * contributes 0. Callers exclude `skip` events before summing (Requirement
 * 24.3).
 */
function readingMsForEvent(event: FeedEventRecord): number {
  const raw = (event.payload as { dwellMs?: unknown }).dwellMs;
  const ms =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** The distinct, non-null article ids referenced by a set of events. */
function distinctArticleIds(events: readonly FeedEventRecord[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.articleId != null) ids.add(e.articleId);
  }
  return [...ids];
}

/** The set of topics reachable from a set of article ids via the topic map. */
function topicsForArticles(
  articleIds: readonly string[],
  topicsByArticleId: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const topics = new Set<string>();
  for (const id of articleIds) {
    for (const topicId of topicsByArticleId.get(id) ?? []) {
      topics.add(topicId);
    }
  }
  return topics;
}

/** The inputs the pure {@link computeMonthlyInsights} aggregation consumes. */
export interface ComputeMonthlyInsightsInput {
  /** The `YYYY-MM` label of the month being aggregated. */
  monthLabel: string;
  /** All of the user's events occurring within the month (any type). */
  monthEvents: readonly FeedEventRecord[];
  /** The user's `dwell` events occurring strictly before the month. */
  priorDwellEvents: readonly FeedEventRecord[];
  /** Source of each article referenced by an in-month dwell event. */
  sourceByArticleId: ReadonlyMap<string, Source>;
  /** Topic ids associated with each referenced article (month and prior). */
  topicsByArticleId: ReadonlyMap<string, readonly string[]>;
}

/**
 * Pure monthly aggregation (Requirements 24.1, 24.3, 24.8). Given the in-month
 * events, the prior `dwell` events, and the article→source / article→topics
 * lookups, computes the article-read count, quality reading minutes (skips
 * excluded), newly discovered topic count, and the per-source minute breakdown.
 * With empty inputs it returns zero counts and an empty breakdown
 * (Requirement 24.8).
 */
export function computeMonthlyInsights(
  input: ComputeMonthlyInsightsInput,
): MonthlyInsights {
  const {
    monthLabel,
    monthEvents,
    priorDwellEvents,
    sourceByArticleId,
    topicsByArticleId,
  } = input;

  // (24.1) Articles read: distinct articles with a dwell event in the month.
  const monthDwellEvents = monthEvents.filter(
    (e) => e.type === 'dwell' && e.articleId != null,
  );
  const monthDwellArticleIds = distinctArticleIds(monthDwellEvents);
  const articlesRead = monthDwellArticleIds.length;

  // (24.1, 24.3) Quality reading minutes: sum dwell milliseconds over every
  // non-skip event, then floor to whole minutes. Skip events are excluded.
  const qualityMs = monthEvents.reduce(
    (sum, e) => (e.type === 'skip' ? sum : sum + readingMsForEvent(e)),
    0,
  );
  const qualityReadingMinutes = Math.floor(qualityMs / MS_PER_MINUTE);

  // (24.3) Per-source breakdown: attribute each in-month dwell's milliseconds to
  // its article's source, floor each source to whole minutes, omit sub-minute
  // sources, and order by descending minutes then source.
  const msBySource = new Map<Source, number>();
  for (const e of monthDwellEvents) {
    const source = e.articleId != null ? sourceByArticleId.get(e.articleId) : undefined;
    if (source === undefined) continue;
    msBySource.set(source, (msBySource.get(source) ?? 0) + readingMsForEvent(e));
  }
  const readingTimeBySource: SourceReadingTime[] = [...msBySource.entries()]
    .map(([source, ms]) => ({ source, minutes: Math.floor(ms / MS_PER_MINUTE) }))
    .filter((entry) => entry.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.source.localeCompare(b.source));

  // (24.1) Newly discovered topics: topics dwelled this month whose first dwell
  // across all history is in the month, i.e. topics engaged this month minus
  // those already engaged before the month.
  const monthTopics = topicsForArticles(monthDwellArticleIds, topicsByArticleId);
  const priorTopics = topicsForArticles(
    distinctArticleIds(priorDwellEvents),
    topicsByArticleId,
  );
  let newlyDiscoveredTopics = 0;
  for (const topicId of monthTopics) {
    if (!priorTopics.has(topicId)) newlyDiscoveredTopics += 1;
  }

  return {
    month: monthLabel,
    articlesRead,
    qualityReadingMinutes,
    newlyDiscoveredTopics,
    readingTimeBySource,
  };
}

/**
 * Compute a user's monthly insights at `nowMs` (Requirements 24.1, 24.3, 24.8).
 *
 * Fetches the month's events and the user's prior `dwell` history through the
 * repository layer, resolves the source of each read article and the topics of
 * every referenced article, then delegates to the pure
 * {@link computeMonthlyInsights}. A user with no events in the month and no
 * prior dwell history yields zero counts and an empty breakdown
 * (Requirement 24.8) without issuing any article or topic lookups.
 *
 * Note: determining "newly discovered" topics requires knowing whether a topic
 * was engaged before the month, so the prior query scans the user's full dwell
 * history. This stays well-scoped by restricting that query to `dwell` events
 * (the only reading signal); a dedicated aggregate query could replace it later
 * if the history grows large.
 */
export async function getMonthlyInsights(
  deps: MonthlyInsightsDeps,
  userId: string,
  nowMs: number,
): Promise<MonthlyInsights> {
  const { db } = deps;
  const bounds = monthBounds(nowMs);

  // All in-month events (any type), and the full prior dwell history.
  const monthEvents = await listFeedEventsInWindow(db, userId, {
    from: bounds.startIso,
    to: bounds.endIso,
  });
  const priorDwellEvents = await listFeedEventsInWindow(db, userId, {
    from: EPOCH_ISO,
    to: bounds.startIso,
    types: ['dwell'],
  });

  // Article ids whose source we need (in-month reads) and whose topics we need
  // (in-month reads + prior dwells, for newly-discovered classification).
  const monthDwellArticleIds = distinctArticleIds(
    monthEvents.filter((e) => e.type === 'dwell' && e.articleId != null),
  );
  const priorDwellArticleIds = distinctArticleIds(priorDwellEvents);

  // Resolve the source of each read article (deduplicated lookups).
  const sourceByArticleId = new Map<string, Source>();
  for (const articleId of monthDwellArticleIds) {
    const article = await findArticleById(db, articleId);
    if (article) sourceByArticleId.set(articleId, article.source);
  }

  // Resolve topic associations for every referenced article in one query.
  const topicArticleIds = [
    ...new Set([...monthDwellArticleIds, ...priorDwellArticleIds]),
  ];
  const associations = await listTopicIdsForArticles(db, topicArticleIds);
  const topicsByArticleId = new Map<string, string[]>();
  for (const assoc of associations) {
    const existing = topicsByArticleId.get(assoc.articleId);
    if (existing) existing.push(assoc.topicId);
    else topicsByArticleId.set(assoc.articleId, [assoc.topicId]);
  }

  return computeMonthlyInsights({
    monthLabel: bounds.label,
    monthEvents,
    priorDwellEvents,
    sourceByArticleId,
    topicsByArticleId,
  });
}

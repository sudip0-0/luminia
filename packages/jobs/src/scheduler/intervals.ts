// Per-source crawl intervals (Requirement 5.5).
//
// The Scheduler triggers each Source's crawl on a fixed cadence: Wikipedia
// hourly, Hacker News every 15 minutes, and Medium / arXiv / MIT News / Quanta
// every 6 hours. These intervals are expressed in milliseconds so they map
// directly onto a BullMQ repeatable job's `repeat: { every }` option, and are
// declared here as the single source of truth consumed by
// `registerCrawlSchedules` (see `./register.ts`).

import type { Source } from '@lumina/shared';

/** Milliseconds in one minute. */
export const ONE_MINUTE_MS = 60_000;

/** Milliseconds in fifteen minutes — the Hacker News crawl cadence. */
export const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;

/** Milliseconds in one hour — the Wikipedia crawl cadence. */
export const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** Milliseconds in six hours — the Medium / arXiv / MIT News / Quanta cadence. */
export const SIX_HOURS_MS = 6 * ONE_HOUR_MS;

/**
 * The crawl interval, in milliseconds, for every {@link Source}. This is the
 * single source of truth for the Scheduler's per-source cadence
 * (Requirement 5.5):
 *
 * - Wikipedia — hourly (`ONE_HOUR_MS`)
 * - Hacker News — every 15 minutes (`FIFTEEN_MINUTES_MS`)
 * - Medium, arXiv, MIT News, Quanta — every 6 hours (`SIX_HOURS_MS`)
 */
export const CRAWL_INTERVALS: Record<Source, number> = {
  wikipedia: ONE_HOUR_MS,
  hacker_news: FIFTEEN_MINUTES_MS,
  medium: SIX_HOURS_MS,
  arxiv: SIX_HOURS_MS,
  mit_news: SIX_HOURS_MS,
  quanta: SIX_HOURS_MS,
};

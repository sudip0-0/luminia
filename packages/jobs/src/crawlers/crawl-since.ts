// Crawl-window computation and the shared `crawlSince` orchestration helper
// (Requirements 5.3, 5.4).
//
// A crawl cycle fetches items published since the source's last successful
// crawl when one exists (Requirement 5.3), and otherwise within the 24-hour
// backfill window immediately preceding the cycle (Requirement 5.4). After a
// successful crawl the helper advances the source's `last_successful_crawl_at`
// via the injected {@link CrawlStateStore} (Requirement 5.3), so the next cycle
// continues from where this one ended.
//
// `computeCrawlWindow` is PURE and total (no I/O, never throws on finite
// input), which keeps the window arithmetic cheap to test. `crawlSince` adds
// the impure concerns — fetching via the Crawler and advancing crawl_state —
// and enforces the window boundaries on the returned items regardless of how
// precisely the Source honoured the requested range.

import type { Crawler, CrawlStateStore, CrawlWindow, RawContentItem } from './types.js';

/** The first-run backfill window: 24 hours, in milliseconds (Requirement 5.4). */
export const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the crawl window for a cycle running at `nowMs`.
 *
 * - When `lastSuccessfulCrawlAt` is a parseable ISO-8601 timestamp, the window
 *   starts at that instant (Requirement 5.3) and `isBackfill` is `false`.
 * - When it is `null` (or unparseable), the window starts 24 hours before
 *   `nowMs` (Requirement 5.4) and `isBackfill` is `true`.
 *
 * The window is inclusive on both ends: an item published exactly at `sinceMs`
 * or exactly at `untilMs` is in scope. The lower bound is never allowed to
 * exceed `nowMs`; a `last_successful_crawl_at` in the future is clamped to
 * `nowMs`, yielding an empty window rather than a reversed one. Pure and total.
 */
export function computeCrawlWindow(
  lastSuccessfulCrawlAt: string | null,
  nowMs: number,
): CrawlWindow {
  const untilMs = nowMs;

  const parsed = lastSuccessfulCrawlAt === null ? Number.NaN : Date.parse(lastSuccessfulCrawlAt);

  if (Number.isNaN(parsed)) {
    return {
      sinceMs: untilMs - BACKFILL_WINDOW_MS,
      untilMs,
      isBackfill: true,
    };
  }

  // Never start after "now": a future last-crawl time clamps to an empty window.
  const sinceMs = Math.min(parsed, untilMs);
  return { sinceMs, untilMs, isBackfill: false };
}

/** `true` when `item.publishedAt` falls within `[window.sinceMs, window.untilMs]`. */
export function isWithinWindow(item: RawContentItem, window: CrawlWindow): boolean {
  const publishedMs = Date.parse(item.publishedAt);
  if (Number.isNaN(publishedMs)) return false;
  return publishedMs >= window.sinceMs && publishedMs <= window.untilMs;
}

/** Dependencies for the {@link crawlSince} orchestration helper. */
export interface CrawlSinceDeps {
  /**
   * Injected crawl-state store. When present, the source's
   * `last_successful_crawl_at` is advanced to the cycle's `nowMs` after a
   * successful crawl (Requirement 5.3). Omit it to compute and run a window
   * without persisting advancement.
   */
  store?: CrawlStateStore;
  /**
   * When `true` (the default), items whose `publishedAt` falls outside the
   * computed window are dropped so the result honours the window boundaries
   * even if the Source over-returns. Set to `false` to return the Crawler's
   * items verbatim.
   */
  enforceWindow?: boolean;
}

/** Outcome of a {@link crawlSince} cycle. */
export interface CrawlSinceResult {
  /** The window that was computed and fetched. */
  window: CrawlWindow;
  /** Items returned by the Crawler, filtered to the window when enforced. */
  items: RawContentItem[];
  /** ISO-8601 timestamp the crawl_state was advanced to, or `null` when not advanced. */
  advancedTo: string | null;
}

/**
 * Run one crawl cycle for `crawler`: compute the fetch window from
 * `lastSuccessfulCrawlAt` and `nowMs` (Requirements 5.3, 5.4), fetch and parse
 * items through the Crawler, drop any item published outside the window (unless
 * disabled), and — when a {@link CrawlStateStore} is injected — advance the
 * source's `last_successful_crawl_at` to `nowMs` (Requirement 5.3).
 *
 * crawl_state is advanced only after the fetch succeeds, so a failing fetch
 * (which rejects) leaves the previous successful-crawl time untouched and the
 * next cycle retries the same window.
 */
export async function crawlSince(
  crawler: Crawler,
  lastSuccessfulCrawlAt: string | null,
  nowMs: number,
  deps: CrawlSinceDeps = {},
): Promise<CrawlSinceResult> {
  const window = computeCrawlWindow(lastSuccessfulCrawlAt, nowMs);

  const fetched = await crawler.fetchItems(window);

  const enforceWindow = deps.enforceWindow ?? true;
  const items = enforceWindow ? fetched.filter((item) => isWithinWindow(item, window)) : fetched;

  let advancedTo: string | null = null;
  if (deps.store) {
    advancedTo = new Date(nowMs).toISOString();
    await deps.store.setLastSuccessfulCrawlAt(crawler.source, advancedTo);
  }

  return { window, items, advancedTo };
}

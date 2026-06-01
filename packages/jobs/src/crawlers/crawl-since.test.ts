import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import type { Source } from '@lumina/shared';
import {
  BACKFILL_WINDOW_MS,
  computeCrawlWindow,
  crawlSince,
  isWithinWindow,
} from './crawl-since.js';
import type { Crawler, CrawlStateStore, CrawlWindow, RawContentItem } from './types.js';

// Verifies the crawl-window logic and the `crawlSince` orchestration
// (Requirements 5.3, 5.4): first-run uses the 24h backfill window, subsequent
// runs use since-last-crawl, window boundaries are inclusive, and crawl_state
// advances after a successful crawl.

const NOW = Date.parse('2024-06-01T12:00:00.000Z');

/** A Crawler stub that returns a fixed item list and records the window it saw. */
function stubCrawler(
  source: Source,
  items: RawContentItem[],
): Crawler & { lastWindow: CrawlWindow | null } {
  const stub = {
    source,
    lastWindow: null as CrawlWindow | null,
    async fetchItems(window: CrawlWindow): Promise<RawContentItem[]> {
      stub.lastWindow = window;
      return items;
    },
  };
  return stub;
}

/** An in-memory crawl-state store implementing the injected boundary. */
function fakeStore(initial: Partial<Record<Source, string | null>> = {}): CrawlStateStore & {
  readonly writes: Array<{ source: Source; at: string }>;
} {
  const state = new Map<Source, string | null>(Object.entries(initial) as Array<[Source, string | null]>);
  const writes: Array<{ source: Source; at: string }> = [];
  return {
    writes,
    async getLastSuccessfulCrawlAt(source: Source) {
      return state.get(source) ?? null;
    },
    async setLastSuccessfulCrawlAt(source: Source, at: string) {
      state.set(source, at);
      writes.push({ source, at });
    },
  };
}

function item(url: string, publishedAt: string, source: Source = 'wikipedia'): RawContentItem {
  return { url, title: 't', body: 'b', publishedAt, source };
}

describe('computeCrawlWindow', () => {
  it('uses the 24-hour backfill window on first run (no previous crawl)', () => {
    const window = computeCrawlWindow(null, NOW);
    expect(window.isBackfill).toBe(true);
    expect(window.untilMs).toBe(NOW);
    expect(window.sinceMs).toBe(NOW - BACKFILL_WINDOW_MS);
  });

  it('uses since-last-crawl when a previous successful crawl exists', () => {
    const last = '2024-06-01T06:00:00.000Z';
    const window = computeCrawlWindow(last, NOW);
    expect(window.isBackfill).toBe(false);
    expect(window.sinceMs).toBe(Date.parse(last));
    expect(window.untilMs).toBe(NOW);
  });

  it('treats an unparseable last-crawl timestamp as a first run (backfill)', () => {
    const window = computeCrawlWindow('not-a-date', NOW);
    expect(window.isBackfill).toBe(true);
    expect(window.sinceMs).toBe(NOW - BACKFILL_WINDOW_MS);
  });

  it('clamps a future last-crawl time to now, yielding an empty (non-reversed) window', () => {
    const future = new Date(NOW + 60_000).toISOString();
    const window = computeCrawlWindow(future, NOW);
    expect(window.sinceMs).toBe(NOW);
    expect(window.untilMs).toBe(NOW);
    expect(window.sinceMs).toBeLessThanOrEqual(window.untilMs);
  });

  it('always produces sinceMs <= untilMs for any inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 4_102_444_800_000 }), { nil: null }),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        (lastMs, nowMs) => {
          const last = lastMs === null ? null : new Date(lastMs).toISOString();
          const window = computeCrawlWindow(last, nowMs);
          expect(window.untilMs).toBe(nowMs);
          expect(window.sinceMs).toBeLessThanOrEqual(window.untilMs);
          if (last === null) {
            expect(window.isBackfill).toBe(true);
            expect(window.sinceMs).toBe(nowMs - BACKFILL_WINDOW_MS);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('isWithinWindow (inclusive boundaries)', () => {
  const window: CrawlWindow = { sinceMs: NOW - BACKFILL_WINDOW_MS, untilMs: NOW, isBackfill: true };

  it('includes an item published exactly at the lower bound', () => {
    expect(isWithinWindow(item('u', new Date(window.sinceMs).toISOString()), window)).toBe(true);
  });

  it('includes an item published exactly at the upper bound', () => {
    expect(isWithinWindow(item('u', new Date(window.untilMs).toISOString()), window)).toBe(true);
  });

  it('excludes an item published just before the lower bound', () => {
    expect(isWithinWindow(item('u', new Date(window.sinceMs - 1).toISOString()), window)).toBe(false);
  });

  it('excludes an item published just after the upper bound', () => {
    expect(isWithinWindow(item('u', new Date(window.untilMs + 1).toISOString()), window)).toBe(false);
  });

  it('excludes an item with an unparseable publication timestamp', () => {
    expect(isWithinWindow(item('u', 'not-a-date'), window)).toBe(false);
  });
});

describe('crawlSince', () => {
  it('first run: computes the 24h backfill window and advances crawl_state to now', async () => {
    const items = [item('https://example.com/a', new Date(NOW - 3_600_000).toISOString())];
    const crawler = stubCrawler('wikipedia', items);
    const store = fakeStore(); // no prior state ⇒ first run

    const last = await store.getLastSuccessfulCrawlAt('wikipedia');
    const result = await crawlSince(crawler, last, NOW, { store });

    expect(result.window.isBackfill).toBe(true);
    expect(crawler.lastWindow?.sinceMs).toBe(NOW - BACKFILL_WINDOW_MS);
    expect(result.items).toHaveLength(1);
    expect(result.advancedTo).toBe(new Date(NOW).toISOString());
    expect(store.writes).toEqual([{ source: 'wikipedia', at: new Date(NOW).toISOString() }]);
  });

  it('subsequent run: uses since-last-crawl and advances crawl_state again', async () => {
    const last = '2024-06-01T06:00:00.000Z';
    const items = [item('https://example.com/a', '2024-06-01T09:00:00.000Z')];
    const crawler = stubCrawler('hacker_news', items);
    const store = fakeStore({ hacker_news: last });

    const prior = await store.getLastSuccessfulCrawlAt('hacker_news');
    const result = await crawlSince(crawler, prior, NOW, { store });

    expect(result.window.isBackfill).toBe(false);
    expect(result.window.sinceMs).toBe(Date.parse(last));
    expect(result.advancedTo).toBe(new Date(NOW).toISOString());
    expect(await store.getLastSuccessfulCrawlAt('hacker_news')).toBe(new Date(NOW).toISOString());
  });

  it('drops items published outside the computed window', async () => {
    const inWindow = item('https://example.com/in', new Date(NOW - 3_600_000).toISOString());
    const tooOld = item('https://example.com/old', new Date(NOW - BACKFILL_WINDOW_MS - 1).toISOString());
    const tooNew = item('https://example.com/new', new Date(NOW + 1).toISOString());
    const crawler = stubCrawler('quanta', [tooOld, inWindow, tooNew]);

    const result = await crawlSince(crawler, null, NOW);

    expect(result.items).toEqual([inWindow]);
  });

  it('returns items verbatim when window enforcement is disabled', async () => {
    const tooOld = item('https://example.com/old', new Date(NOW - BACKFILL_WINDOW_MS - 1).toISOString());
    const crawler = stubCrawler('medium', [tooOld]);

    const result = await crawlSince(crawler, null, NOW, { enforceWindow: false });

    expect(result.items).toEqual([tooOld]);
  });

  it('does not advance crawl_state when no store is injected', async () => {
    const crawler = stubCrawler('arxiv', []);
    const result = await crawlSince(crawler, null, NOW);
    expect(result.advancedTo).toBeNull();
  });

  it('leaves crawl_state untouched when the fetch fails', async () => {
    const store = fakeStore({ mit_news: '2024-06-01T06:00:00.000Z' });
    const failing: Crawler = {
      source: 'mit_news',
      fetchItems: vi.fn().mockRejectedValue(new Error('boom')),
    };

    await expect(crawlSince(failing, '2024-06-01T06:00:00.000Z', NOW, { store })).rejects.toThrow('boom');

    expect(store.writes).toHaveLength(0);
    expect(await store.getLastSuccessfulCrawlAt('mit_news')).toBe('2024-06-01T06:00:00.000Z');
  });
});

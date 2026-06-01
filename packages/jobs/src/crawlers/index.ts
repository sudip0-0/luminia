// Crawler layer barrel (Requirements 5.1, 5.3, 5.4).
//
// Re-exports the Crawler interface, RawContentItem and supporting types, the
// crawl-window logic and `crawlSince` helper, and the six source crawlers.
// This is a layer-local barrel for the new `crawlers/` directory; it is
// deliberately independent of the package-level `src/index.ts`.

import type { Source } from '@lumina/shared';

export type {
  Crawler,
  CrawlStateStore,
  CrawlWindow,
  FetchResult,
  Fetcher,
  RawContentItem,
} from './types.js';
export { CrawlError } from './types.js';

export {
  BACKFILL_WINDOW_MS,
  computeCrawlWindow,
  crawlSince,
  isWithinWindow,
  type CrawlSinceDeps,
  type CrawlSinceResult,
} from './crawl-since.js';

export { isSuccessStatus, fetchBodyOrThrow } from './base.js';

export { parseRssFeed, parseAtomFeed } from './feed-parsers.js';

export { WikipediaCrawler, WIKIPEDIA_FEED_URL, parseWikipediaPayload } from './sources/wikipedia.js';
export {
  HackerNewsCrawler,
  HACKER_NEWS_FEED_URL,
  parseHackerNewsPayload,
} from './sources/hacker-news.js';
export { ArxivCrawler, ARXIV_FEED_URL, parseArxivFeed } from './sources/arxiv.js';
export { MediumCrawler, MEDIUM_FEED_URL, parseMediumFeed } from './sources/medium.js';
export { MitNewsCrawler, MIT_NEWS_FEED_URL, parseMitNewsFeed } from './sources/mit-news.js';
export { QuantaCrawler, QUANTA_FEED_URL, parseQuantaFeed } from './sources/quanta.js';

import type { Crawler, Fetcher } from './types.js';
import { WikipediaCrawler } from './sources/wikipedia.js';
import { HackerNewsCrawler } from './sources/hacker-news.js';
import { ArxivCrawler } from './sources/arxiv.js';
import { MediumCrawler } from './sources/medium.js';
import { MitNewsCrawler } from './sources/mit-news.js';
import { QuantaCrawler } from './sources/quanta.js';

/**
 * Construct one Crawler per Source, all sharing the injected {@link Fetcher}.
 * The returned map is keyed by Source so the Scheduler/orchestrator (later
 * tasks) can address each crawler directly. Covers all six Sources
 * (Requirement 5.1).
 */
export function createCrawlers(fetcher: Fetcher): Record<Source, Crawler> {
  return {
    wikipedia: new WikipediaCrawler(fetcher),
    medium: new MediumCrawler(fetcher),
    hacker_news: new HackerNewsCrawler(fetcher),
    arxiv: new ArxivCrawler(fetcher),
    mit_news: new MitNewsCrawler(fetcher),
    quanta: new QuantaCrawler(fetcher),
  };
}

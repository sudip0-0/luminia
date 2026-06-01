// Quanta Magazine Crawler (Requirement 5.1).
//
// Quanta publishes through an RSS 2.0 feed. Parsing is delegated to the shared
// RSS parser; `parseQuantaFeed` tags items with the quanta Source. Pure and
// total.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { parseRssFeed } from '../feed-parsers.js';

const SOURCE = 'quanta' as const;

/** Default RSS endpoint; the window is enforced after fetch by `crawlSince`. */
export const QUANTA_FEED_URL = 'https://www.quantamagazine.org/feed/';

/** Parse a Quanta RSS feed body into RawContentItem[]. Pure and total. */
export function parseQuantaFeed(body: string): RawContentItem[] {
  return parseRssFeed(body, SOURCE);
}

/** Crawler for Quanta Magazine (Requirement 5.1). */
export class QuantaCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = QUANTA_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseQuantaFeed(body);
  }
}

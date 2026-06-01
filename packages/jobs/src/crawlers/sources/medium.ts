// Medium Crawler (Requirement 5.1).
//
// Medium publishes posts through an RSS 2.0 feed. Parsing is delegated to the
// shared RSS parser; `parseMediumFeed` tags items with the medium Source. Pure
// and total.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { parseRssFeed } from '../feed-parsers.js';

const SOURCE = 'medium' as const;

/** Default RSS endpoint; the window is enforced after fetch by `crawlSince`. */
export const MEDIUM_FEED_URL = 'https://medium.com/feed/tag/technology';

/** Parse a Medium RSS feed body into RawContentItem[]. Pure and total. */
export function parseMediumFeed(body: string): RawContentItem[] {
  return parseRssFeed(body, SOURCE);
}

/** Crawler for Medium (Requirement 5.1). */
export class MediumCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = MEDIUM_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseMediumFeed(body);
  }
}

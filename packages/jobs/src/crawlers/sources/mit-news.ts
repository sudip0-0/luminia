// MIT News Crawler (Requirement 5.1).
//
// MIT News publishes through an RSS 2.0 feed. Parsing is delegated to the
// shared RSS parser; `parseMitNewsFeed` tags items with the mit_news Source.
// Pure and total.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { parseRssFeed } from '../feed-parsers.js';

const SOURCE = 'mit_news' as const;

/** Default RSS endpoint; the window is enforced after fetch by `crawlSince`. */
export const MIT_NEWS_FEED_URL = 'https://news.mit.edu/rss/feed';

/** Parse an MIT News RSS feed body into RawContentItem[]. Pure and total. */
export function parseMitNewsFeed(body: string): RawContentItem[] {
  return parseRssFeed(body, SOURCE);
}

/** Crawler for MIT News (Requirement 5.1). */
export class MitNewsCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = MIT_NEWS_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseMitNewsFeed(body);
  }
}

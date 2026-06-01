// arXiv Crawler (Requirement 5.1).
//
// arXiv exposes new submissions through an Atom feed (the Atom API). Parsing is
// delegated to the shared Atom parser; `parseArxivFeed` simply tags items with
// the arxiv Source. Pure and total.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { parseAtomFeed } from '../feed-parsers.js';

const SOURCE = 'arxiv' as const;

/** Default Atom API endpoint; the window is enforced after fetch by `crawlSince`. */
export const ARXIV_FEED_URL =
  'https://export.arxiv.org/api/query?search_query=all&sortBy=submittedDate&sortOrder=descending';

/** Parse an arXiv Atom feed body into RawContentItem[]. Pure and total. */
export function parseArxivFeed(body: string): RawContentItem[] {
  return parseAtomFeed(body, SOURCE);
}

/** Crawler for arXiv (Requirement 5.1). */
export class ArxivCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = ARXIV_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseArxivFeed(body);
  }
}

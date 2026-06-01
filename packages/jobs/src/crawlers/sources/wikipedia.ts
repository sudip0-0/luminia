// Wikipedia Crawler (Requirement 5.1).
//
// Wikipedia exposes recently-created/featured content via a JSON API. The
// `parseWikipediaPayload` function is pure and total: it maps a representative
// JSON shape into RawContentItem[] and skips entries that lack a URL or a
// parseable timestamp. The Crawler class wires it to an injected Fetcher.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { isRecord, readString, safeJsonParse, toIso } from '../parse-helpers.js';

const SOURCE = 'wikipedia' as const;

/** Default API endpoint; the window is enforced after fetch by `crawlSince`. */
export const WIKIPEDIA_FEED_URL =
  'https://en.wikipedia.org/w/api.php?action=query&list=recentchanges&format=json';

/**
 * Parse a representative Wikipedia JSON payload of the shape
 * `{ "items": [ { "url", "title", "extract", "timestamp" } ] }` into
 * RawContentItem[]. Pure and total — malformed input yields `[]`.
 */
export function parseWikipediaPayload(body: string): RawContentItem[] {
  const json = safeJsonParse(body);
  if (!isRecord(json)) return [];
  const rawItems = json['items'];
  if (!Array.isArray(rawItems)) return [];

  const items: RawContentItem[] = [];
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue;
    const url = readString(entry, 'url');
    const publishedAt = toIso(readString(entry, 'timestamp'));
    if (url === '' || publishedAt === null) continue;
    items.push({
      url,
      title: readString(entry, 'title'),
      body: readString(entry, 'extract'),
      publishedAt,
      source: SOURCE,
    });
  }
  return items;
}

/** Crawler for Wikipedia (Requirement 5.1). */
export class WikipediaCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = WIKIPEDIA_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseWikipediaPayload(body);
  }
}

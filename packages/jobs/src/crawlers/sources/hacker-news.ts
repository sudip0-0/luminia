// Hacker News Crawler (Requirement 5.1).
//
// Hacker News exposes stories via the Firebase JSON API. `parseHackerNewsPayload`
// maps a representative item-list shape into RawContentItem[] and is pure and
// total. Hacker News timestamps are epoch seconds (`time`), handled by `toIso`.

import type { Crawler, CrawlWindow, Fetcher, RawContentItem } from '../types.js';
import { fetchBodyOrThrow } from '../base.js';
import { isRecord, readString, safeJsonParse, toIso } from '../parse-helpers.js';

const SOURCE = 'hacker_news' as const;

/** Default API endpoint; the window is enforced after fetch by `crawlSince`. */
export const HACKER_NEWS_FEED_URL = 'https://hacker-news.firebaseio.com/v0/newstories.json';

/**
 * Parse a representative Hacker News JSON payload of the shape
 * `{ "items": [ { "url", "title", "text", "time" (epoch seconds) } ] }` into
 * RawContentItem[]. Pure and total — malformed input yields `[]`.
 */
export function parseHackerNewsPayload(body: string): RawContentItem[] {
  const json = safeJsonParse(body);
  if (!isRecord(json)) return [];
  const rawItems = json['items'];
  if (!Array.isArray(rawItems)) return [];

  const items: RawContentItem[] = [];
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue;
    const url = readString(entry, 'url');
    const time = entry['time'];
    const publishedAt = typeof time === 'number' ? toIso(time) : toIso(readString(entry, 'time'));
    if (url === '' || publishedAt === null) continue;
    items.push({
      url,
      title: readString(entry, 'title'),
      body: readString(entry, 'text'),
      publishedAt,
      source: SOURCE,
    });
  }
  return items;
}

/** Crawler for Hacker News (Requirement 5.1). */
export class HackerNewsCrawler implements Crawler {
  readonly source = SOURCE;
  private readonly fetcher: Fetcher;
  private readonly feedUrl: string;

  constructor(fetcher: Fetcher, feedUrl: string = HACKER_NEWS_FEED_URL) {
    this.fetcher = fetcher;
    this.feedUrl = feedUrl;
  }

  async fetchItems(_window: CrawlWindow): Promise<RawContentItem[]> {
    const body = await fetchBodyOrThrow(this.fetcher, this.source, this.feedUrl);
    return parseHackerNewsPayload(body);
  }
}

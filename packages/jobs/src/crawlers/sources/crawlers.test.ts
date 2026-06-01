import { describe, it, expect, vi } from 'vitest';
import type { Fetcher, FetchResult } from '../types.js';
import { CrawlError } from '../types.js';
import { computeCrawlWindow } from '../crawl-since.js';
import { createCrawlers } from '../index.js';
import { WikipediaCrawler, parseWikipediaPayload } from './wikipedia.js';
import { HackerNewsCrawler, parseHackerNewsPayload } from './hacker-news.js';
import { ArxivCrawler, parseArxivFeed } from './arxiv.js';
import { MediumCrawler, parseMediumFeed } from './medium.js';
import { parseMitNewsFeed } from './mit-news.js';
import { QuantaCrawler, parseQuantaFeed } from './quanta.js';

// Verifies each of the six source crawlers parses a representative payload into
// RawContentItem[] (Requirement 5.1) and that a non-2xx response surfaces as a
// CrawlError so the pipeline can isolate the source (Requirement 5.6).

/** A Fetcher that always returns the given result, recording requested URLs. */
function okFetcher(body: string, status = 200): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetch(url: string): Promise<FetchResult> {
      urls.push(url);
      return { status, body };
    },
  };
}

const WINDOW = computeCrawlWindow(null, Date.parse('2024-06-01T12:00:00.000Z'));

describe('Wikipedia crawler', () => {
  const payload = JSON.stringify({
    items: [
      {
        url: 'https://en.wikipedia.org/wiki/Photosynthesis',
        title: 'Photosynthesis',
        extract: 'The process by which plants convert light into chemical energy.',
        timestamp: '2024-06-01T08:00:00Z',
      },
      // Missing url ⇒ skipped.
      { title: 'No URL', extract: 'x', timestamp: '2024-06-01T08:00:00Z' },
    ],
  });

  it('parses a representative JSON payload', () => {
    const items = parseWikipediaPayload(payload);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'wikipedia',
      url: 'https://en.wikipedia.org/wiki/Photosynthesis',
      title: 'Photosynthesis',
    });
    expect(items[0]!.publishedAt).toBe('2024-06-01T08:00:00.000Z');
  });

  it('returns [] for malformed JSON', () => {
    expect(parseWikipediaPayload('not json')).toEqual([]);
    expect(parseWikipediaPayload('{}')).toEqual([]);
  });

  it('fetches and parses through the crawler', async () => {
    const fetcher = okFetcher(payload);
    const items = await new WikipediaCrawler(fetcher).fetchItems(WINDOW);
    expect(items).toHaveLength(1);
    expect(fetcher.urls).toHaveLength(1);
  });
});

describe('Hacker News crawler', () => {
  const payload = JSON.stringify({
    items: [
      {
        url: 'https://example.com/story',
        title: 'A Show HN story',
        text: 'Body text here.',
        time: 1717228800, // epoch seconds = 2024-06-01T08:00:00Z
      },
    ],
  });

  it('parses a representative JSON payload with epoch-seconds time', () => {
    const items = parseHackerNewsPayload(payload);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'hacker_news', url: 'https://example.com/story' });
    expect(items[0]!.publishedAt).toBe('2024-06-01T08:00:00.000Z');
  });

  it('returns [] for malformed JSON', () => {
    expect(parseHackerNewsPayload('[]')).toEqual([]);
  });

  it('fetches and parses through the crawler', async () => {
    const items = await new HackerNewsCrawler(okFetcher(payload)).fetchItems(WINDOW);
    expect(items).toHaveLength(1);
  });
});

describe('arXiv crawler (Atom)', () => {
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>On the Structure of Things</title>
      <id>http://arxiv.org/abs/2406.00001</id>
      <link href="http://arxiv.org/abs/2406.00001v1" rel="alternate" type="text/html"/>
      <published>2024-06-01T08:00:00Z</published>
      <summary>We study the structure of things in detail.</summary>
    </entry>
  </feed>`;

  it('parses a representative Atom payload', () => {
    const items = parseArxivFeed(payload);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'arxiv',
      url: 'http://arxiv.org/abs/2406.00001v1',
      title: 'On the Structure of Things',
    });
    expect(items[0]!.body).toContain('structure of things');
    expect(items[0]!.publishedAt).toBe('2024-06-01T08:00:00.000Z');
  });

  it('fetches and parses through the crawler', async () => {
    const items = await new ArxivCrawler(okFetcher(payload)).fetchItems(WINDOW);
    expect(items).toHaveLength(1);
  });
});

describe('RSS crawlers (Medium, MIT News, Quanta)', () => {
  function rss(link: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <item>
        <title><![CDATA[A Great Article]]></title>
        <link>${link}</link>
        <pubDate>Sat, 01 Jun 2024 08:00:00 GMT</pubDate>
        <description><![CDATA[<p>An <b>HTML</b> summary.</p>]]></description>
      </item>
    </channel></rss>`;
  }

  it('Medium parses a representative RSS payload (RFC-822 date, HTML stripped)', () => {
    const items = parseMediumFeed(rss('https://medium.com/@a/great-article'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'medium',
      url: 'https://medium.com/@a/great-article',
      title: 'A Great Article',
    });
    expect(items[0]!.body).toBe('An HTML summary.');
    expect(items[0]!.publishedAt).toBe('2024-06-01T08:00:00.000Z');
  });

  it('MIT News parses a representative RSS payload', () => {
    const items = parseMitNewsFeed(rss('https://news.mit.edu/2024/great-article'));
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('mit_news');
  });

  it('Quanta parses a representative RSS payload', () => {
    const items = parseQuantaFeed(rss('https://www.quantamagazine.org/great-article'));
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('quanta');
  });

  it('prefers content:encoded over description when present', () => {
    const xml = `<rss><channel><item>
      <title>T</title>
      <link>https://medium.com/@a/x</link>
      <pubDate>Sat, 01 Jun 2024 08:00:00 GMT</pubDate>
      <description><![CDATA[short]]></description>
      <content:encoded><![CDATA[<p>the full body</p>]]></content:encoded>
    </item></channel></rss>`;
    expect(parseMediumFeed(xml)[0]!.body).toBe('the full body');
  });

  it('skips items without a link or without a parseable date', () => {
    const noLink = `<rss><channel><item><title>T</title><pubDate>Sat, 01 Jun 2024 08:00:00 GMT</pubDate></item></channel></rss>`;
    const noDate = `<rss><channel><item><title>T</title><link>https://medium.com/@a/x</link></item></channel></rss>`;
    expect(parseMediumFeed(noLink)).toEqual([]);
    expect(parseMediumFeed(noDate)).toEqual([]);
  });
});

describe('fetch failure isolation (Requirement 5.6)', () => {
  it('throws a CrawlError tagged with the source on a non-2xx response', async () => {
    const fetcher = okFetcher('', 503);
    await expect(new QuantaCrawler(fetcher).fetchItems(WINDOW)).rejects.toBeInstanceOf(CrawlError);
    await expect(new QuantaCrawler(fetcher).fetchItems(WINDOW)).rejects.toMatchObject({
      source: 'quanta',
    });
  });

  it('propagates a fetcher rejection (e.g. timeout)', async () => {
    const fetcher: Fetcher = { fetch: vi.fn().mockRejectedValue(new Error('timeout')) };
    await expect(new MediumCrawler(fetcher).fetchItems(WINDOW)).rejects.toThrow('timeout');
  });
});

describe('createCrawlers', () => {
  it('builds one crawler per Source, each tagged with its source', () => {
    const crawlers = createCrawlers(okFetcher('{}'));
    expect(crawlers.wikipedia.source).toBe('wikipedia');
    expect(crawlers.medium.source).toBe('medium');
    expect(crawlers.hacker_news.source).toBe('hacker_news');
    expect(crawlers.arxiv.source).toBe('arxiv');
    expect(crawlers.mit_news.source).toBe('mit_news');
    expect(crawlers.quanta.source).toBe('quanta');
  });
});

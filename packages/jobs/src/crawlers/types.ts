// Crawler layer types — the source-fetching front of the Ingestion_Pipeline
// (Requirements 5.1, 5.3, 5.4).
//
// A Crawler fetches raw content from a single external Source and parses it
// into a uniform list of RawContentItem. All network access is injected behind
// the Fetcher interface so crawlers and the crawl-window logic can be exercised
// without touching the network. The "since last successful crawl, else 24-hour
// backfill" window logic and the crawl_state advancement live in
// `crawl-since.ts`; this module only declares the shared shapes.

import type { Source } from '@lumina/shared';

/**
 * A single raw content item fetched from a Source, normalized into a uniform
 * shape before it enters the Ingestion_Pipeline (Deduplicator → Quality_Scorer
 * → Summarizer → Embedder → storage). Parsing each Source's payload into this
 * shape is the Crawler's only responsibility (Requirement 5.1).
 */
export interface RawContentItem {
  /** Canonical URL of the item as supplied by the Source. */
  url: string;
  /** Item title. */
  title: string;
  /** Full text / body of the item (may be empty when the Source omits it). */
  body: string;
  /** ISO-8601 publication timestamp. */
  publishedAt: string;
  /** The Source this item was fetched from. */
  source: Source;
}

/** The result of an injected HTTP fetch: a status code and the response body as text. */
export interface FetchResult {
  /** HTTP status code (a 2xx code denotes success). */
  status: number;
  /** Response body as text — JSON for API sources, XML for RSS/Atom feeds. */
  body: string;
}

/**
 * Minimal HTTP client abstraction. Injecting this behind the crawlers lets the
 * source-specific parsing and the crawl-window logic run with a fake fetcher in
 * tests — no network required.
 */
export interface Fetcher {
  /** Fetch the given URL, resolving with its status and body. */
  fetch(url: string): Promise<FetchResult>;
}

/**
 * The time window a crawl cycle should fetch. Items published within
 * `[sinceMs, untilMs]` (inclusive) are in scope. `isBackfill` is `true` when no
 * previous successful crawl existed and the 24-hour backfill window was used
 * (Requirement 5.4), and `false` when the lower bound is the previous
 * successful crawl time (Requirement 5.3).
 */
export interface CrawlWindow {
  /** Inclusive lower bound, in epoch milliseconds. */
  sinceMs: number;
  /** Inclusive upper bound (the crawl cycle's "now"), in epoch milliseconds. */
  untilMs: number;
  /** `true` when the 24-hour first-run backfill window was applied. */
  isBackfill: boolean;
}

/**
 * A Crawler fetches and parses content from exactly one Source. The window is
 * supplied so a Crawler can scope its request (e.g. a since/until query param)
 * where the Source supports it; window boundaries are enforced regardless by
 * {@link crawlSince}. Implementations stay pure given the injected
 * {@link Fetcher}: the only impurity is the fetch call itself.
 */
export interface Crawler {
  /** The Source this Crawler is responsible for. */
  readonly source: Source;
  /** Fetch and parse items for the given crawl window. */
  fetchItems(window: CrawlWindow): Promise<RawContentItem[]>;
}

/**
 * Persistence boundary for per-source crawl bookkeeping (the `crawl_state`
 * table). Injected into {@link crawlSince} so the helper can advance a source's
 * last-successful-crawl timestamp without depending on a database directly —
 * mirrors the API's crawl repository concept (`getCrawlState` /
 * `updateLastSuccessfulCrawl`).
 */
export interface CrawlStateStore {
  /**
   * Resolve the source's last successful crawl time (ISO-8601), or `null` when
   * the source has never crawled — the signal to use the 24-hour backfill
   * window (Requirement 5.4).
   */
  getLastSuccessfulCrawlAt(source: Source): Promise<string | null>;
  /** Advance the source's last successful crawl time to `at` (ISO-8601). */
  setLastSuccessfulCrawlAt(source: Source, at: string): Promise<void>;
}

/** Error raised when a Source returns a non-success response (Requirement 5.6). */
export class CrawlError extends Error {
  /** The Source whose fetch failed. */
  readonly source: Source;

  constructor(source: Source, message: string) {
    super(message);
    this.name = 'CrawlError';
    this.source = source;
  }
}

// Deduplicator — Ingestion_Pipeline component (Requirements 6.1, 6.2).
//
// Removes duplicate articles by URL hash. The hashing and URL normalization
// are PURE and total (they never throw and never perform I/O), which keeps
// them cheap to property-test and reproducible. The only impure concern —
// checking whether a hash already exists — is injected, so the Deduplicator
// can be exercised without a database.
//
// Design references: Requirements 6.1, 6.2 and Property 5
// ("URL-hash deduplication discards exactly colliding articles; normalized-URL
// equality and hash equality always agree").

import { createHash } from 'node:crypto';

/**
 * Query-string parameters that carry no content identity and must be removed
 * before hashing so that the same article shared through different campaigns
 * normalizes to a single URL. Any parameter whose lowercased name begins with
 * `utm_` is also stripped (see {@link isTrackingParam}).
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'gclid',
  'fbclid',
  'dclid',
  'gclsrc',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'referrer',
  'spm',
  'yclid',
  'cmpid',
  'campaign_id',
  '_hsenc',
  '_hsmi',
]);

/** Default ports that are implied by their scheme and therefore stripped. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
};

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

/**
 * Deterministically normalize a URL so that URLs that point at the same
 * resource produce an identical string. The normalization is total: any input
 * (including strings that are not parseable URLs) yields a stable result.
 *
 * Normalization rules:
 * - Trim surrounding whitespace.
 * - Lowercase the scheme and host (these are case-insensitive by spec).
 * - Strip the port when it is the scheme's default (e.g. `:443` on https).
 * - Remove tracking query parameters (`utm_*`, `gclid`, `fbclid`, …).
 * - Sort the remaining query parameters by name, then value, for a stable order.
 * - Remove a trailing slash from a non-root path. The root path stays `/`,
 *   the canonical form the URL serializer always emits for these schemes, so
 *   `https://example.com` and `https://example.com/` normalize identically.
 * - Drop the fragment (`#…`), which never identifies distinct content.
 *
 * Inputs that cannot be parsed as URLs fall back to a trimmed, lowercased form
 * so the function still returns a deterministic string instead of throwing.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a parseable absolute URL — fall back to a deterministic plain form.
    return trimmed.toLowerCase();
  }

  // Scheme and host are case-insensitive; the URL API already lowercases them,
  // but we normalize explicitly to be robust against future API changes.
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip the default port for the scheme.
  if (parsed.port !== '' && DEFAULT_PORTS[parsed.protocol] === parsed.port) {
    parsed.port = '';
  }

  // Remove tracking params, then sort the survivors for a stable ordering.
  const kept: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams.entries()) {
    if (!isTrackingParam(name)) {
      kept.push([name, value]);
    }
  }
  kept.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  parsed.search = '';
  for (const [name, value] of kept) {
    parsed.searchParams.append(name, value);
  }

  // Drop the fragment; it does not change the underlying resource.
  parsed.hash = '';

  // Remove a trailing slash from a non-root path. The root path is left as the
  // serializer's canonical "/" so that "host" and "host/" normalize identically.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compute the SHA-256 hex digest (64 lowercase hex characters) of the
 * normalized form of {@link url}. Equivalent URLs (those that normalize to the
 * same string) always produce the same hash, and distinct normalized URLs
 * produce distinct hashes (modulo SHA-256 collisions). Pure and total.
 */
export function urlHash(url: string): string {
  return createHash('sha256').update(normalizeUrl(url), 'utf8').digest('hex');
}

/**
 * Lookup over the URL hashes of already-stored articles. Injected so the
 * Deduplicator can run against any backing store (PostgreSQL `url_hash` column,
 * an in-memory set in tests, …) without depending on a database directly.
 */
export interface ExistingHashLookup {
  /** Resolve to `true` if an article with the given URL hash is already stored. */
  existsByHash(hash: string): Promise<boolean>;
}

/** Details of an incoming article rejected because its URL hash collided. */
export interface RejectedDuplicate {
  /** The raw incoming URL as supplied. */
  url: string;
  /** The normalized form of {@link url} used to compute the hash. */
  normalizedUrl: string;
  /** The SHA-256 hex digest that collided with a stored article. */
  urlHash: string;
}

/**
 * Callback invoked when an incoming article is discarded as a duplicate, so the
 * caller can record the rejection (e.g. for metrics or an audit trail). May be
 * synchronous or asynchronous; the Deduplicator awaits the result.
 */
export type DuplicateRecorder = (rejected: RejectedDuplicate) => void | Promise<void>;

/** Dependencies injected into the {@link Deduplicator}. */
export interface DeduplicatorOptions {
  /** Lookup used to detect a hash collision with an already-stored article. */
  lookup: ExistingHashLookup;
  /** Optional sink invoked exactly once per discarded duplicate. */
  recordRejectedDuplicate?: DuplicateRecorder;
}

/** Outcome of evaluating a single incoming article URL. */
export interface DedupResult {
  /** `true` when the URL hash collided with a stored article. */
  isDuplicate: boolean;
  /** The raw incoming URL. */
  url: string;
  /** The normalized form of the URL. */
  normalizedUrl: string;
  /** The SHA-256 hex digest of the normalized URL. */
  urlHash: string;
}

/**
 * The Deduplicator decides whether an incoming article is a duplicate by
 * comparing the SHA-256 hash of its normalized URL against the hashes of
 * stored articles (Requirement 6.1). When the hash collides, the article is
 * discarded without being persisted and recorded as a rejected duplicate
 * (Requirement 6.2). Storage lookup and rejection recording are injected;
 * hashing and normalization stay pure.
 */
export class Deduplicator {
  private readonly lookup: ExistingHashLookup;
  private readonly recordRejectedDuplicate?: DuplicateRecorder;

  constructor(options: DeduplicatorOptions) {
    this.lookup = options.lookup;
    this.recordRejectedDuplicate = options.recordRejectedDuplicate;
  }

  /**
   * Evaluate an incoming article URL. Computes the normalized-URL hash, checks
   * it against stored hashes, and — when it collides — signals rejection via
   * the injected recorder. Returns whether the article is a duplicate along
   * with the computed normalized URL and hash.
   */
  async evaluate(url: string): Promise<DedupResult> {
    const normalizedUrl = normalizeUrl(url);
    const hash = urlHash(url);

    const isDuplicate = await this.lookup.existsByHash(hash);

    const result: DedupResult = { isDuplicate, url, normalizedUrl, urlHash: hash };

    if (isDuplicate && this.recordRejectedDuplicate) {
      await this.recordRejectedDuplicate({ url, normalizedUrl, urlHash: hash });
    }

    return result;
  }

  /**
   * Convenience predicate that returns only whether the incoming article is a
   * duplicate. Rejection recording still occurs as a side effect on collision.
   */
  async isDuplicate(url: string): Promise<boolean> {
    return (await this.evaluate(url)).isDuplicate;
  }
}

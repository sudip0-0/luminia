// Shared crawler plumbing: fetch-with-status-check.
//
// Every source crawler issues exactly one fetch per cycle through the injected
// {@link Fetcher} and must treat a non-2xx response as a failure so the
// pipeline can record a `crawl_failure` and isolate the source (Requirement
// 5.6). This helper centralizes that contract; per-source parsing stays pure.

import type { Source } from '@lumina/shared';
import { CrawlError, type Fetcher } from './types.js';

/** `true` for a 2xx HTTP status code. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Fetch `url` via `fetcher` and return the response body on success. Throws a
 * {@link CrawlError} tagged with `source` on any non-2xx response so the
 * orchestrator can record the failure and continue with other sources
 * (Requirement 5.6).
 */
export async function fetchBodyOrThrow(
  fetcher: Fetcher,
  source: Source,
  url: string,
): Promise<string> {
  const result = await fetcher.fetch(url);
  if (!isSuccessStatus(result.status)) {
    throw new CrawlError(source, `${source} fetch failed with status ${result.status}`);
  }
  return result.body;
}

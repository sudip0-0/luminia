import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  Deduplicator,
  normalizeUrl,
  urlHash,
  type ExistingHashLookup,
  type RejectedDuplicate,
} from './dedup.js';

/** In-memory hash store implementing the injected lookup, for tests. */
function hashStore(initial: Iterable<string> = []): ExistingHashLookup & { add(hash: string): void } {
  const hashes = new Set<string>(initial);
  return {
    add(hash: string) {
      hashes.add(hash);
    },
    async existsByHash(hash: string) {
      return hashes.has(hash);
    },
  };
}

describe('normalizeUrl', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path/To/Article')).toBe(
      'https://example.com/Path/To/Article'
    );
  });

  it('strips default ports for http and https', () => {
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });

  it('keeps non-default ports', () => {
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('removes a trailing slash from a non-root path and canonicalizes the root', () => {
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
    // The URL serializer always emits a root "/", so both forms agree.
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com')).toBe(normalizeUrl('https://example.com/'));
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('removes tracking query params (utm_*, gclid, fbclid, ref)', () => {
    expect(
      normalizeUrl('https://example.com/a?utm_source=news&utm_medium=email&gclid=x&fbclid=y&ref=z')
    ).toBe('https://example.com/a');
  });

  it('keeps content-bearing query params and sorts them deterministically', () => {
    const a = normalizeUrl('https://example.com/a?b=2&a=1');
    const b = normalizeUrl('https://example.com/a?a=1&b=2');
    expect(a).toBe(b);
    expect(a).toBe('https://example.com/a?a=1&b=2');
  });

  it('treats tracking-only query strings as equal to no query string', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('is idempotent', () => {
    const once = normalizeUrl('HTTPS://Example.com:443/a/?utm_source=x&b=2&a=1#frag');
    expect(normalizeUrl(once)).toBe(once);
  });

  it('falls back to a trimmed, lowercased form for unparseable input', () => {
    expect(normalizeUrl('   Not A URL  ')).toBe('not a url');
  });
});

describe('urlHash', () => {
  it('returns a 64-character lowercase hex SHA-256 digest', () => {
    const hash = urlHash('https://example.com/a');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the SHA-256 of the normalized URL', () => {
    const url = 'HTTPS://Example.com:443/a/?utm_source=x&b=2&a=1#frag';
    const expected = createHash('sha256').update(normalizeUrl(url), 'utf8').digest('hex');
    expect(urlHash(url)).toBe(expected);
  });

  it('produces equal hashes for URLs that normalize the same', () => {
    expect(urlHash('https://example.com/a/')).toBe(urlHash('https://EXAMPLE.com/a'));
    expect(urlHash('https://example.com/a?utm_source=x')).toBe(urlHash('https://example.com/a'));
  });

  it('produces different hashes for genuinely different URLs', () => {
    expect(urlHash('https://example.com/a')).not.toBe(urlHash('https://example.com/b'));
  });
});

describe('Deduplicator', () => {
  it('reports a non-duplicate when no stored hash collides', async () => {
    const lookup = hashStore();
    const dedup = new Deduplicator({ lookup });

    const result = await dedup.evaluate('https://example.com/new');

    expect(result.isDuplicate).toBe(false);
    expect(result.urlHash).toBe(urlHash('https://example.com/new'));
    expect(result.normalizedUrl).toBe(normalizeUrl('https://example.com/new'));
  });

  it('detects a duplicate when the URL hash collides with a stored article', async () => {
    const lookup = hashStore([urlHash('https://example.com/dup')]);
    const dedup = new Deduplicator({ lookup });

    expect(await dedup.isDuplicate('https://example.com/dup')).toBe(true);
  });

  it('detects a duplicate even when the incoming URL differs only by normalization', async () => {
    const lookup = hashStore([urlHash('https://example.com/dup')]);
    const dedup = new Deduplicator({ lookup });

    // Different scheme case, trailing slash, tracking param, and fragment.
    expect(await dedup.isDuplicate('HTTPS://Example.com/dup/?utm_source=news#top')).toBe(true);
  });

  it('records a rejected duplicate exactly once on collision', async () => {
    const lookup = hashStore([urlHash('https://example.com/dup')]);
    const recorder = vi.fn<(r: RejectedDuplicate) => void>();
    const dedup = new Deduplicator({ lookup, recordRejectedDuplicate: recorder });

    await dedup.evaluate('https://example.com/dup');

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith({
      url: 'https://example.com/dup',
      normalizedUrl: normalizeUrl('https://example.com/dup'),
      urlHash: urlHash('https://example.com/dup'),
    });
  });

  it('does not record a rejection for a non-duplicate', async () => {
    const lookup = hashStore();
    const recorder = vi.fn<(r: RejectedDuplicate) => void>();
    const dedup = new Deduplicator({ lookup, recordRejectedDuplicate: recorder });

    await dedup.evaluate('https://example.com/unique');

    expect(recorder).not.toHaveBeenCalled();
  });

  it('awaits an asynchronous recorder before resolving', async () => {
    const lookup = hashStore([urlHash('https://example.com/dup')]);
    const order: string[] = [];
    const dedup = new Deduplicator({
      lookup,
      recordRejectedDuplicate: async () => {
        await Promise.resolve();
        order.push('recorded');
      },
    });

    await dedup.evaluate('https://example.com/dup');
    order.push('resolved');

    expect(order).toEqual(['recorded', 'resolved']);
  });
});

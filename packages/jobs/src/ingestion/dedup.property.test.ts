// Feature: lumina, Property 5: URL-hash deduplication discards exactly colliding articles
//
// Property-based coverage for the Deduplicator (Ingestion_Pipeline component,
// Requirements 6.1 and 6.2).
//
// Property 5 (design.md): *For any* incoming article and any set of stored
// articles, the article is discarded as a duplicate if and only if the SHA-256
// hash of its normalized URL equals the URL hash of some stored article;
// normalized-URL equality and hash equality always agree.
//
// This file exercises three complementary sub-properties, each at a minimum of
// 100 generated iterations:
//
//   (1) discard-iff-collision: with an in-memory lookup built from the hashes
//       of a generated set of stored URLs, Deduplicator.isDuplicate(incoming)
//       returns true exactly when the incoming URL's normalized hash already
//       exists, and a rejection is recorded exactly on collision (Req 6.1/6.2).
//   (2) hash-equality-agrees-with-normalization: for any two URLs (parseable or
//       junk), urlHash(a) === urlHash(b) iff normalizeUrl(a) === normalizeUrl(b).
//   (3) normalize-preserving variations collide: case, default port, trailing
//       slash, tracking params, reordered query params, and fragments all
//       normalize equal and therefore hash equal.
//
// Implementation files are not modified; this test only observes the public
// dedup API. URLs are produced by smart generators that assemble valid URLs
// from constrained parts, so generated input stays inside the URL input space
// while still varying the dimensions the normalizer cares about.
//
// Validates: Requirements 6.1, 6.2

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  Deduplicator,
  normalizeUrl,
  urlHash,
  type ExistingHashLookup,
  type RejectedDuplicate,
} from './dedup.js';

const RUNS = { numRuns: 200 } as const;

// --- Smart URL generators ---------------------------------------------------

const SCHEMES = ['http', 'https'] as const;
// Valid hostnames; a small pool keeps cross-URL collisions reachable.
const HOSTS = ['example.com', 'news.example', 'blog.test', 'a.co', 'sub.domain.org'] as const;
// Query parameter names that carry content identity (none are tracking params).
const CONTENT_NAMES = ['id', 'page', 'q', 'sort', 'category', 'tag'] as const;
// Tracking parameters the normalizer strips regardless of position/value.
const TRACKING_NAMES = ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid', 'ref'] as const;

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
const SEG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

/** Alphanumeric value, never empty, never needing percent-encoding. */
const valueArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(''));

/** A single path segment (no dot segments, no characters needing encoding). */
const segmentArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SEG_CHARS), { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(''));

interface QueryParam {
  name: string;
  value: string;
}

/** Canonical, normalization-independent description of a URL. */
interface UrlSpec {
  scheme: (typeof SCHEMES)[number];
  host: (typeof HOSTS)[number];
  segments: string[];
  params: QueryParam[];
}

const urlSpec: fc.Arbitrary<UrlSpec> = fc.record({
  scheme: fc.constantFrom(...SCHEMES),
  host: fc.constantFrom(...HOSTS),
  segments: fc.array(segmentArb, { maxLength: 4 }),
  params: fc.array(
    fc.record({ name: fc.constantFrom(...CONTENT_NAMES), value: valueArb }),
    { maxLength: 4 }
  ),
});

/**
 * Noise that the normalizer is required to erase. Applying any of these to a
 * spec must yield a URL that normalizes (and therefore hashes) identically to
 * the spec's canonical rendering.
 */
interface Variation {
  upperScheme: boolean;
  upperHost: boolean;
  defaultPort: boolean;
  trailingSlash: boolean;
  reverseParams: boolean;
  trackingFirst: boolean;
  tracking: QueryParam[];
  fragment?: string;
}

const variationArb: fc.Arbitrary<Variation> = fc.record({
  upperScheme: fc.boolean(),
  upperHost: fc.boolean(),
  defaultPort: fc.boolean(),
  trailingSlash: fc.boolean(),
  reverseParams: fc.boolean(),
  trackingFirst: fc.boolean(),
  tracking: fc.array(
    fc.record({ name: fc.constantFrom(...TRACKING_NAMES), value: valueArb }),
    { maxLength: 3 }
  ),
  fragment: fc.option(fc.constantFrom('sec', 'top', 'frag-1'), { nil: undefined }),
});

function buildQuery(content: QueryParam[], variation?: Variation): string {
  let contentParts = content.map((p) => `${p.name}=${p.value}`);
  if (variation?.reverseParams) contentParts = [...contentParts].reverse();
  const trackingParts = (variation?.tracking ?? []).map((t) => `${t.name}=${t.value}`);
  const all = variation?.trackingFirst
    ? [...trackingParts, ...contentParts]
    : [...contentParts, ...trackingParts];
  return all.length > 0 ? `?${all.join('&')}` : '';
}

/**
 * Render a URL string from a spec. With no variation this is the canonical
 * form; with a variation it injects normalization-erasable noise (case,
 * default port, trailing slash, tracking params, query reordering, fragment).
 */
function render(spec: UrlSpec, variation?: Variation): string {
  const scheme = variation?.upperScheme ? spec.scheme.toUpperCase() : spec.scheme;
  const host = variation?.upperHost ? spec.host.toUpperCase() : spec.host;
  const port = variation?.defaultPort ? (spec.scheme === 'http' ? ':80' : ':443') : '';
  let path = spec.segments.length > 0 ? `/${spec.segments.join('/')}` : '';
  if (variation?.trailingSlash) path = `${path}/`;
  const query = buildQuery(spec.params, variation);
  const fragment = variation?.fragment ? `#${variation.fragment}` : '';
  return `${scheme}://${host}${port}${path}${query}${fragment}`;
}

/** In-memory lookup over a fixed set of URL hashes. */
function makeLookup(hashes: Iterable<string>): ExistingHashLookup {
  const set = new Set(hashes);
  return {
    async existsByHash(hash: string) {
      return set.has(hash);
    },
  };
}

// --- Properties -------------------------------------------------------------

describe('Property 5 - URL-hash deduplication discards exactly colliding articles (Req 6.1, 6.2)', () => {
  it('(1) isDuplicate is true iff the normalized-URL hash collides with a stored hash, and records exactly then', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(urlSpec, { maxLength: 6 }),
        urlSpec,
        fc.boolean(),
        fc.nat(),
        variationArb,
        async (storedSpecs, freshSpec, useStored, index, variation) => {
          const storedUrls = storedSpecs.map((s) => render(s));
          const storedHashes = storedUrls.map((u) => urlHash(u));
          const lookup = makeLookup(storedHashes);

          // Build the incoming URL: either a normalization-noised variant of a
          // stored article (a guaranteed collision) or a fresh URL. Either way
          // the expected outcome is computed from the actual hashes, so a fresh
          // URL that happens to collide is still handled correctly.
          let incoming: string;
          if (useStored && storedSpecs.length > 0) {
            incoming = render(storedSpecs[index % storedSpecs.length]!, variation);
          } else {
            incoming = render(freshSpec);
          }

          const expected = new Set(storedHashes).has(urlHash(incoming));

          const rejected: RejectedDuplicate[] = [];
          const dedup = new Deduplicator({
            lookup,
            recordRejectedDuplicate: (r) => {
              rejected.push(r);
            },
          });

          const result = await dedup.evaluate(incoming);

          // Discard decision agrees with hash collision against stored set. The
          // convenience predicate is checked on a separate recorder-free
          // instance so it does not double-count the rejection recorded below.
          expect(result.isDuplicate).toBe(expected);
          const plainDedup = new Deduplicator({ lookup });
          expect(await plainDedup.isDuplicate(incoming)).toBe(expected);

          // A rejection is recorded exactly once on collision and never otherwise.
          expect(rejected.length).toBe(expected ? 1 : 0);
          if (expected) {
            expect(rejected[0]!.urlHash).toBe(urlHash(incoming));
            expect(rejected[0]!.normalizedUrl).toBe(normalizeUrl(incoming));
          }
        }
      ),
      RUNS
    );
  });

  it('(2) hash equality agrees with normalized-URL equality for any two URLs', async () => {
    // Pairs that are intentionally normalization-equivalent, exercising the
    // "equal" branch of the biconditional.
    const equivalentPair: fc.Arbitrary<[string, string]> = fc
      .record({ spec: urlSpec, variation: variationArb })
      .map(({ spec, variation }) => [render(spec), render(spec, variation)]);

    // Arbitrary pairs, including unparseable junk strings that drive the
    // normalizer's deterministic fallback path.
    const anyUrl: fc.Arbitrary<string> = fc.oneof(
      urlSpec.map((s) => render(s)),
      urlSpec.chain((s) => variationArb.map((v) => render(s, v))),
      fc.string()
    );
    const arbitraryPair: fc.Arbitrary<[string, string]> = fc.tuple(anyUrl, anyUrl);

    await fc.assert(
      fc.asyncProperty(fc.oneof(equivalentPair, arbitraryPair), async ([a, b]) => {
        const hashEqual = urlHash(a) === urlHash(b);
        const normalizeEqual = normalizeUrl(a) === normalizeUrl(b);
        expect(hashEqual).toBe(normalizeEqual);
      }),
      RUNS
    );
  });

  it('(3) case, port, trailing slash, tracking params, reordering, and fragments normalize and hash equal', async () => {
    await fc.assert(
      fc.asyncProperty(urlSpec, variationArb, async (spec, variation) => {
        const canonical = render(spec);
        const varied = render(spec, variation);

        // The variation only injects noise the normalizer must erase, so both
        // forms must normalize identically and therefore hash identically.
        expect(normalizeUrl(varied)).toBe(normalizeUrl(canonical));
        expect(urlHash(varied)).toBe(urlHash(canonical));

        // And the Deduplicator treats the varied form as a duplicate of the
        // canonical one when the canonical hash is already stored.
        const lookup = makeLookup([urlHash(canonical)]);
        const dedup = new Deduplicator({ lookup });
        expect(await dedup.isDuplicate(varied)).toBe(true);
      }),
      RUNS
    );
  });
});

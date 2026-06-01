// Feature: lumina, Property 39: Search filters are applied conjunctively
//
// Property-based coverage for `buildSearchFilters` (Requirement 20.7), which
// builds a Typesense `filter_by` string by joining each provided source,
// topic, read-time, and date-range clause with ` && ` so results match ALL
// provided filters simultaneously.
//
// Property 39 (design.md): *For any* search request with a set of source,
// topic, read-time, and date-range filters, every returned article satisfies
// *all* specified filters simultaneously. At the pure `filter_by`-construction
// layer this means: the emitted string contains exactly one clause per
// contributing filter, all conjoined with ` && `, with each filter's expected
// clause substring present, in a deterministic field order; and it is
// `undefined` when no filter contributes a clause.
//
// The properties below use an INDEPENDENT oracle (literal field-name strings
// and a re-derived range-clause builder) rather than importing the
// implementation's `ARTICLE_FIELD`, so the test does not merely mirror the
// production code. Each property runs a minimum of 100 generated iterations.
// Implementation files are not modified; this test only observes the public
// `buildSearchFilters` API.
//
// Validates: Requirements 20.7

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SOURCES } from '@lumina/shared';
import { buildSearchFilters, type SearchFilters } from './filters.js';

const RUNS = { numRuns: 200 } as const;

// Indexed `articles` field names, declared independently of the implementation
// so the oracle is a true second source of truth.
const FIELD = {
  source: 'source',
  topicSlugs: 'topic_slugs',
  readTimeMinutes: 'read_time_minutes',
  publishedAt: 'published_at',
} as const;

// --- Independent oracle ----------------------------------------------------

/** Inclusive numeric range clause, or null when neither bound is present. */
function rangeClause(
  field: string,
  min: number | undefined,
  max: number | undefined,
): string | null {
  if (min !== undefined && max !== undefined) return `${field}:[${min}..${max}]`;
  if (min !== undefined) return `${field}:>=${min}`;
  if (max !== undefined) return `${field}:<=${max}`;
  return null;
}

/**
 * The clauses we expect `buildSearchFilters` to emit, in the canonical field
 * order: source, topic, read-time, date-range. Filters that are absent — or
 * ranges with no bound — contribute nothing.
 */
function expectedClauses(f: SearchFilters): string[] {
  const clauses: string[] = [];
  if (f.source !== undefined) clauses.push(`${FIELD.source}:=${f.source}`);
  if (f.topic !== undefined) clauses.push(`${FIELD.topicSlugs}:=${f.topic}`);
  if (f.readTime !== undefined) {
    const c = rangeClause(FIELD.readTimeMinutes, f.readTime.min, f.readTime.max);
    if (c !== null) clauses.push(c);
  }
  if (f.dateRange !== undefined) {
    const c = rangeClause(FIELD.publishedAt, f.dateRange.from, f.dateRange.to);
    if (c !== null) clauses.push(c);
  }
  return clauses;
}

// --- Generators ------------------------------------------------------------

const sourceArb = fc.constantFrom(...SOURCES);

// URL-safe taxonomy slug; constrained to slug characters so it never contains
// the ` && ` separator or `&`, keeping clause/separator counting unambiguous.
const slugArb = fc
  .array(
    fc.constantFrom(
      'physics',
      'machine-learning',
      'ai',
      'biology',
      'space',
      'a',
      'b',
      '1',
      '-',
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((parts) => parts.join(''));

const optionalInt = fc.option(fc.integer({ min: 0, max: 1000 }), {
  nil: undefined,
});
const epochArb = fc.integer({ min: 1_000_000_000, max: 2_000_000_000 });
const optionalEpoch = fc.option(epochArb, { nil: undefined });

// A read-time range that may carry both, one, or neither bound. The
// neither-bound case exercises a "present but contributes nothing" filter.
const readTimeArb = fc.record({ min: optionalInt, max: optionalInt });
const dateRangeArb = fc.record({ from: optionalEpoch, to: optionalEpoch });

// Arbitrary combination of present/absent filters with varied values.
const filtersArb: fc.Arbitrary<SearchFilters> = fc.record({
  source: fc.option(sourceArb, { nil: undefined }),
  topic: fc.option(slugArb, { nil: undefined }),
  readTime: fc.option(readTimeArb, { nil: undefined }),
  dateRange: fc.option(dateRangeArb, { nil: undefined }),
});

// Filters that, by construction, contribute no clause: source/topic absent and
// any range either absent or carrying no bound.
const emptyRange = fc.constantFrom<SearchFilters['readTime']>(
  undefined,
  {},
  { min: undefined, max: undefined },
);
const noContributionArb: fc.Arbitrary<SearchFilters> = fc.record({
  source: fc.constant(undefined),
  topic: fc.constant(undefined),
  readTime: emptyRange,
  dateRange: fc.constantFrom<SearchFilters['dateRange']>(
    undefined,
    {},
    { from: undefined, to: undefined },
  ),
});

describe('Property 39 - search filters are applied conjunctively (Req 20.7)', () => {
  it('emits exactly one clause per contributing filter, joined by " && "', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const result = buildSearchFilters(filters);
        const expected = expectedClauses(filters);

        if (expected.length === 0) {
          expect(result).toBeUndefined();
          return;
        }

        expect(result).toBeDefined();
        const parts = result!.split(' && ');
        // One clause per contributing filter...
        expect(parts.length).toBe(expected.length);
        // ...joined by exactly (clauses - 1) ` && ` separators.
        const separators = result!.match(/ && /g) ?? [];
        expect(separators.length).toBe(expected.length - 1);
      }),
      RUNS,
    );
  });

  it('contributes the expected clause substring for each provided filter', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const result = buildSearchFilters(filters) ?? '';

        if (filters.source !== undefined) {
          expect(result).toContain(`${FIELD.source}:=${filters.source}`);
        }
        if (filters.topic !== undefined) {
          expect(result).toContain(`${FIELD.topicSlugs}:=${filters.topic}`);
        }
        if (filters.readTime !== undefined) {
          const c = rangeClause(
            FIELD.readTimeMinutes,
            filters.readTime.min,
            filters.readTime.max,
          );
          if (c !== null) expect(result).toContain(c);
        }
        if (filters.dateRange !== undefined) {
          const c = rangeClause(
            FIELD.publishedAt,
            filters.dateRange.from,
            filters.dateRange.to,
          );
          if (c !== null) expect(result).toContain(c);
        }
      }),
      RUNS,
    );
  });

  it('returns undefined when no filter (or only empty ranges) applies', () => {
    fc.assert(
      fc.property(noContributionArb, (filters) => {
        expect(buildSearchFilters(filters)).toBeUndefined();
      }),
      RUNS,
    );
  });

  it('orders clauses deterministically (source, topic, read-time, date-range)', () => {
    fc.assert(
      fc.property(filtersArb, (filters) => {
        const expected = expectedClauses(filters);
        const expectedString =
          expected.length > 0 ? expected.join(' && ') : undefined;

        // Output matches the canonical field-order join exactly...
        expect(buildSearchFilters(filters)).toBe(expectedString);
        // ...and is stable across repeated invocations (no hidden ordering).
        expect(buildSearchFilters(filters)).toBe(buildSearchFilters(filters));
      }),
      RUNS,
    );
  });
});

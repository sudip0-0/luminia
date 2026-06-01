// Feature: lumina, Property 7: Stored articles satisfy the completeness invariant
//
// Property-based coverage for the storage completeness gate
// (Requirements 6.5, 6.6, 7.5).
//
// Property 7 (design.md): *For any* article that reaches the stored state, it
// has a non-null URL, source, title, summary, cleaned full text, a quality
// score >= 0.3, an embedding vector of exactly 1536 dimensions, and a read time
// that is a whole number of minutes >= 1.
//
// This file exercises three complementary sub-properties, each over a minimum
// of 100 generated iterations. A reference predicate `satisfiesInvariant`
// re-states the completeness invariant independently of the implementation, so
// the tests check the gate against an external definition rather than against
// itself:
//
//   (1) Gate definition: across articles spanning a fully-complete variant and
//       per-field degraded variants, `isStorable(article)` returns true if and
//       only if every field satisfies the invariant; `findMissingFields` is
//       empty exactly when storable, and every field it flags genuinely fails.
//   (2) Storage side effects: driving `storeArticle` with a fake repository and
//       search index, the article is persisted AND indexed exactly once iff it
//       is storable; on rejection NO side effect occurs (neither
//       `insertComplete` nor `indexComplete` is ever called).
//   (3) Stored implies complete: every article that reaches the stored state
//       (`storeArticle` returns status 'stored') satisfies the full invariant.
//
// Generators deliberately span the boundaries the gate must police: embeddings
// of length 1535 / 1536 / 1537 and embeddings containing NaN; quality scores
// below and at/above the 0.3 threshold; read times of 0, fractional, and >= 1;
// and empty / whitespace-only / non-empty strings, plus valid and invalid
// sources. Implementation files are not modified; this test only observes the
// public storage-gate API.
//
// Validates: Requirements 6.5, 6.6, 7.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SOURCES } from '@lumina/shared';
import {
  EMBEDDING_DIMENSIONS,
  isStorable,
  findMissingFields,
  storeArticle,
  type CompleteArticleInput,
  type StoreArticleDeps,
} from './storage-gate.js';

const RUNS = { numRuns: 200 } as const;

// The minimum quality score and read time the invariant requires. Restated
// here (rather than imported) so the reference predicate is an independent
// description of Property 7.
const QUALITY_MIN = 0.3;
const READ_TIME_MIN = 1;

// ---------------------------------------------------------------------------
// Reference predicate — an independent restatement of the completeness
// invariant (Property 7). A generated article is storable IFF this returns
// true. The tests compare the implementation against this definition.
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function satisfiesInvariant(article: Record<string, unknown>): boolean {
  if (article == null) return false;

  const quality = article.qualityScore;
  const embedding = article.embedding;
  const readTime = article.readTimeMinutes;

  return (
    isNonEmptyString(article.url) &&
    typeof article.source === 'string' &&
    (SOURCES as readonly string[]).includes(article.source) &&
    isNonEmptyString(article.title) &&
    isNonEmptyString(article.summary) &&
    isNonEmptyString(article.fullText) &&
    typeof quality === 'number' &&
    Number.isFinite(quality) &&
    quality >= QUALITY_MIN &&
    Array.isArray(embedding) &&
    embedding.length === EMBEDDING_DIMENSIONS &&
    embedding.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof readTime === 'number' &&
    Number.isInteger(readTime) &&
    readTime >= READ_TIME_MIN
  );
}

// ---------------------------------------------------------------------------
// Field generators — each spans valid and invalid values so any field can be
// independently degraded.
// ---------------------------------------------------------------------------

const finiteNumber: fc.Arbitrary<number> = fc.double({
  min: -10,
  max: 10,
  noNaN: true,
});

// Non-empty (post-trim) strings, prefixed so trimming can never empty them.
const validString: fc.Arbitrary<string> = fc
  .string({ maxLength: 24 })
  .map((s) => `x${s}`);

// Strings that the invariant must reject: empty and whitespace-only.
const invalidString: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  '  \t\n ',
);

const stringField: fc.Arbitrary<string> = fc.oneof(validString, invalidString);

// A valid source vs. an invalid one (empty / unknown provider).
const sourceField: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SOURCES),
  fc.constantFrom('', 'twitter', 'reddit', 'unknown', 'WIKIPEDIA'),
);

// Quality scores spanning below 0.3, the exact boundary, above 0.3, and
// non-finite adversarial values.
const qualityField: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: 0, max: QUALITY_MIN, noNaN: true }),
  fc.double({ min: QUALITY_MIN, max: 1, noNaN: true }),
  fc.constantFrom(
    QUALITY_MIN,
    QUALITY_MIN - Number.EPSILON,
    QUALITY_MIN + Number.EPSILON,
    0,
    1,
    -1,
    0.2999,
    0.3001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ),
);

// Embeddings of varied length (including 1535 / 1536 / 1537), some containing
// NaN, so only exactly-1536 all-finite vectors are valid.
const embeddingField: fc.Arbitrary<number[]> = fc.oneof(
  // Exactly 1536 finite numbers — the only valid shape.
  fc.array(finiteNumber, {
    minLength: EMBEDDING_DIMENSIONS,
    maxLength: EMBEDDING_DIMENSIONS,
  }),
  // One short.
  fc.array(finiteNumber, {
    minLength: EMBEDDING_DIMENSIONS - 1,
    maxLength: EMBEDDING_DIMENSIONS - 1,
  }),
  // One long.
  fc.array(finiteNumber, {
    minLength: EMBEDDING_DIMENSIONS + 1,
    maxLength: EMBEDDING_DIMENSIONS + 1,
  }),
  // Correct length but containing a NaN.
  fc
    .array(finiteNumber, {
      minLength: EMBEDDING_DIMENSIONS,
      maxLength: EMBEDDING_DIMENSIONS,
    })
    .map((arr) => {
      const copy = [...arr];
      copy[0] = Number.NaN;
      return copy;
    }),
  // Correct length but containing an Infinity.
  fc
    .array(finiteNumber, {
      minLength: EMBEDDING_DIMENSIONS,
      maxLength: EMBEDDING_DIMENSIONS,
    })
    .map((arr) => {
      const copy = [...arr];
      copy[copy.length - 1] = Number.POSITIVE_INFINITY;
      return copy;
    }),
  // Small varied-length arrays.
  fc.array(finiteNumber, { minLength: 0, maxLength: 8 }),
);

// Read times: whole minutes >= 1 (valid) plus 0, negative, and fractional.
const readTimeField: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: READ_TIME_MIN, max: 240 }),
  fc.constantFrom(0, -1, -7),
  fc.constantFrom(0.5, 1.5, 2.5, 0.999, 1.0001),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
);

// An article whose every field is independently valid or degraded.
const mixedArticleArb = fc.record({
  url: stringField,
  source: sourceField,
  title: stringField,
  summary: stringField,
  fullText: stringField,
  qualityScore: qualityField,
  embedding: embeddingField,
  readTimeMinutes: readTimeField,
}) as fc.Arbitrary<Record<string, unknown>>;

// An always-complete article, used to guarantee the stored branch is exercised.
const completeArticleArb = fc.record({
  url: validString,
  source: fc.constantFrom(...SOURCES),
  title: validString,
  summary: validString,
  fullText: validString,
  qualityScore: fc.double({ min: QUALITY_MIN, max: 1, noNaN: true }),
  embedding: fc.array(finiteNumber, {
    minLength: EMBEDDING_DIMENSIONS,
    maxLength: EMBEDDING_DIMENSIONS,
  }),
  readTimeMinutes: fc.integer({ min: READ_TIME_MIN, max: 240 }),
}) as fc.Arbitrary<Record<string, unknown>>;

// Either a complete article or an arbitrarily-degraded one, biased so the
// storable branch occurs often enough to exercise sub-properties (2) and (3).
const anyArticleArb = fc.oneof(
  { weight: 1, arbitrary: completeArticleArb },
  { weight: 2, arbitrary: mixedArticleArb },
);

// A fresh fake repository + search index that records every call, so we can
// assert exactly which side effects occurred.
function makeFakeDeps(): {
  deps: StoreArticleDeps;
  calls: {
    insertComplete: CompleteArticleInput[];
    indexComplete: (CompleteArticleInput & { id: string })[];
  };
} {
  const calls = {
    insertComplete: [] as CompleteArticleInput[],
    indexComplete: [] as (CompleteArticleInput & { id: string })[],
  };
  let counter = 0;
  const deps: StoreArticleDeps = {
    repository: {
      async insertComplete(article) {
        calls.insertComplete.push(article);
        return { id: `id-${++counter}` };
      },
    },
    searchIndex: {
      async indexComplete(article) {
        calls.indexComplete.push(article);
      },
    },
  };
  return { deps, calls };
}

describe('Property 7 - stored articles satisfy the completeness invariant (Req 6.5, 6.6, 7.5)', () => {
  it('(1) isStorable is true IFF every field satisfies the invariant', () => {
    fc.assert(
      fc.property(anyArticleArb, (article) => {
        const expected = satisfiesInvariant(article);
        const partial = article as Partial<CompleteArticleInput>;

        // The gate agrees with the independent invariant definition.
        expect(isStorable(partial)).toBe(expected);

        // findMissingFields is empty exactly when the article is storable.
        const missing = findMissingFields(partial);
        expect(missing.length === 0).toBe(expected);

        // Every field the gate flags genuinely fails the invariant, and the
        // reported list contains no duplicates.
        expect(new Set(missing).size).toBe(missing.length);
        for (const field of missing) {
          const repaired = { ...article } as Record<string, unknown>;
          // Replace just the flagged field with a known-good value and confirm
          // it no longer appears in the missing list.
          repaired[field] = goodValueFor(field);
          expect(findMissingFields(repaired as Partial<CompleteArticleInput>)).not.toContain(
            field,
          );
        }
      }),
      RUNS,
    );
  });

  it('(2) storeArticle persists+indexes IFF storable, and performs no side effects on rejection', async () => {
    await fc.assert(
      fc.asyncProperty(anyArticleArb, async (article) => {
        const expected = satisfiesInvariant(article);
        const { deps, calls } = makeFakeDeps();

        const result = await storeArticle(deps, article as Partial<CompleteArticleInput>);

        if (expected) {
          expect(result.status).toBe('stored');
          // Persisted exactly once, then indexed exactly once.
          expect(calls.insertComplete).toHaveLength(1);
          expect(calls.indexComplete).toHaveLength(1);
          if (result.status === 'stored') {
            // The indexed article carries the id returned by persistence.
            expect(calls.indexComplete[0].id).toBe(result.id);
          }
        } else {
          expect(result.status).toBe('rejected');
          // Rejection performs NO side effects.
          expect(calls.insertComplete).toHaveLength(0);
          expect(calls.indexComplete).toHaveLength(0);
          if (result.status === 'rejected') {
            expect(result.missingFields.length).toBeGreaterThan(0);
          }
        }
      }),
      RUNS,
    );
  });

  it('(3) every article that reaches the stored state satisfies the full invariant', async () => {
    await fc.assert(
      fc.asyncProperty(anyArticleArb, async (article) => {
        const { deps } = makeFakeDeps();
        const result = await storeArticle(deps, article as Partial<CompleteArticleInput>);

        if (result.status === 'stored') {
          // Reaching the stored state implies the completeness invariant holds.
          expect(satisfiesInvariant(article)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

// A known-good replacement value for a single completeness field, used in
// sub-property (1) to confirm each flagged field is individually responsible
// for its own rejection.
function goodValueFor(field: string): unknown {
  switch (field) {
    case 'url':
    case 'title':
    case 'summary':
    case 'fullText':
      return 'valid-non-empty';
    case 'source':
      return SOURCES[0];
    case 'qualityScore':
      return 0.5;
    case 'embedding':
      return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
    case 'readTimeMinutes':
      return 3;
    default:
      return undefined;
  }
}

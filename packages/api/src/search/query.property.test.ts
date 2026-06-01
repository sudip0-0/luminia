// Feature: lumina, Property 38: Search query validation rejects empty, whitespace-only, and oversized queries
//
// Property-based coverage for the Search_Service query-length validation
// (Requirement 20.5). `validateSearchQuery(q)` accepts a query if and only if
// its trimmed length is within [SEARCH_QUERY_MIN_LENGTH, SEARCH_QUERY_MAX_LENGTH]
// = [1, 200]; empty, whitespace-only, and oversized queries are rejected.
//
// Property 38 (design.md): *For any* query string, the search is performed if
// and only if its trimmed length is in [1, 200]; empty, whitespace-only, or
// >200-character queries are rejected with a validation error and no search is
// executed.
//
// Four complementary properties are exercised below (each runs >= 100
// iterations):
//   (1) any string whose trimmed length is in [1, 200] is accepted, even with
//       arbitrary surrounding whitespace;
//   (2) empty and whitespace-only strings are rejected;
//   (3) any string whose trimmed length is > 200 is rejected;
//   (4) the general oracle: acceptance equals (trimmed length in [1, 200]) for
//       arbitrary strings, including surrounding whitespace.
//
// Implementation files are not modified; this test only observes the pure
// `validateSearchQuery` boundary function.
//
// Validates: Requirements 20.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  validateSearchQuery,
} from './query.js';

const RUNS = { numRuns: 200 } as const;

// Sanity-check the boundaries this suite assumes, so the properties stay
// meaningful if the constants ever change.
const MIN = SEARCH_QUERY_MIN_LENGTH;
const MAX = SEARCH_QUERY_MAX_LENGTH;

// A single non-whitespace character (printable ASCII, excluding space).
const nonWsChar: fc.Arbitrary<string> = fc
  .char()
  .filter((c) => c.trim().length === 1);

// An arbitrary single character (printable ASCII, may be a space).
const anyChar: fc.Arbitrary<string> = fc.char();

// An arbitrary run of whitespace (possibly empty) to surround a query with.
const whitespace: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 6 })
  .map((parts) => parts.join(''));

// Builds a string whose own trimmed length is exactly `n` (n >= 1): the first
// and last characters are non-whitespace, so `trim()` cannot shorten it, while
// the interior is arbitrary (whitespace allowed, since it is not on an edge).
function coreOfTrimmedLength(n: number): fc.Arbitrary<string> {
  if (n <= 1) {
    return nonWsChar;
  }
  return fc
    .tuple(
      nonWsChar,
      fc
        .array(anyChar, { minLength: n - 2, maxLength: n - 2 })
        .map((parts) => parts.join('')),
      nonWsChar,
    )
    .map(([first, middle, last]) => first + middle + last);
}

describe('Property 38 - search query validation rejects empty, whitespace-only, and oversized queries (Req 20.5)', () => {
  it('(1) accepts any string whose trimmed length is in [1, 200], even with surrounding whitespace', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN, max: MAX }).chain((n) =>
          fc.tuple(whitespace, coreOfTrimmedLength(n), whitespace),
        ),
        ([left, core, right]) => {
          const query = left + core + right;
          // Guard: the construction yields a trimmed length within range.
          expect(query.trim().length).toBeGreaterThanOrEqual(MIN);
          expect(query.trim().length).toBeLessThanOrEqual(MAX);
          expect(validateSearchQuery(query)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('(2) rejects empty and whitespace-only strings', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
            maxLength: 250,
          })
          .map((parts) => parts.join('')),
        (blank) => {
          // Includes the empty string when the array is empty.
          expect(blank.trim().length).toBe(0);
          expect(validateSearchQuery(blank)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('(3) rejects any string whose trimmed length is > 200', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX + 1, max: MAX + 200 }).chain((n) =>
          fc.tuple(whitespace, coreOfTrimmedLength(n), whitespace),
        ),
        ([left, core, right]) => {
          const query = left + core + right;
          // Guard: the construction yields an oversized trimmed length.
          expect(query.trim().length).toBeGreaterThan(MAX);
          expect(validateSearchQuery(query)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('(4) acceptance equals (trimmed length in [1, 200]) for arbitrary strings including surrounding whitespace', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          whitespace,
          // A broad body that straddles the upper boundary so both accept and
          // reject outcomes are exercised.
          fc.string({ minLength: 0, maxLength: MAX + 40 }),
          whitespace,
        ),
        ([left, body, right]) => {
          const query = left + body + right;
          const trimmedLength = query.trim().length;
          const expected = trimmedLength >= MIN && trimmedLength <= MAX;
          expect(validateSearchQuery(query)).toBe(expected);
        },
      ),
      RUNS,
    );
  });
});

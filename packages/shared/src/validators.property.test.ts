// Feature: lumina, Property 1: Input validators accept exactly the allowed ranges
//
// Property-based test for the pure input validators in `./validators.ts`.
//
// Property 1 (design.md): For any candidate value, each pure validator accepts
// the value if and only if it lies within its documented range:
//   - validateEmail        iff a well-formed email of <= 254 characters
//   - validatePassword     iff length in [8, 128]
//   - validateDailyGoal    iff an integer in [5, 120]
//   - validateDepth        iff in { quick, balanced, deep }
//   - validateDisplayName  iff length in [1, 50]
//   - validateCollectionName iff length in [1, 100]
//
// Each property below generates BOTH in-range (must accept) and out-of-range
// (must reject) inputs, exercising both directions of the iff. Every property
// runs a minimum of 100 generated iterations.
//
// Validates: Requirements 1.3, 1.4, 1.7, 1.8, 3.4, 22.1, 26.2, 26.3.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DEPTHS } from './domain.js';
import {
  validateEmail,
  validatePassword,
  validateDailyGoal,
  validateDepth,
  validateDisplayName,
  validateCollectionName,
  MAX_EMAIL_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_DAILY_GOAL,
  MAX_DAILY_GOAL,
  MIN_DISPLAY_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_COLLECTION_NAME_LENGTH,
  MAX_COLLECTION_NAME_LENGTH,
} from './validators.js';

const RUNS = { numRuns: 100 } as const;

// --- Shared generators -----------------------------------------------------

// Single-code-unit printable ASCII characters (0x20..0x7e). Building strings
// from these guarantees `string.length === characterCount`, so the length-based
// validators are exercised at exactly the intended boundaries.
const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i)
);
const asciiChar = fc.constantFrom(...PRINTABLE_ASCII);

/** A string of printable ASCII whose `.length` is in [min, max]. */
function asciiOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc.array(asciiChar, { minLength: min, maxLength: max }).map((cs) => cs.join(''));
}

// --- validateEmail (Requirement 1.3) --------------------------------------

// Characters allowed in the local part (atext) per the validator's pattern.
const ATEXT = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-";
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const atextChar = fc.constantFrom(...ATEXT.split(''));
const alnumChar = fc.constantFrom(...ALNUM.split(''));
const labelMidChar = fc.constantFrom(...(ALNUM + '-').split(''));

const localPart = fc.array(atextChar, { minLength: 1, maxLength: 30 }).map((cs) => cs.join(''));

// A hostname label: a single alnum char, or alnum + (alnum|'-')* + alnum.
const domainLabel = fc.oneof(
  alnumChar,
  fc
    .tuple(alnumChar, fc.array(labelMidChar, { maxLength: 10 }), alnumChar)
    .map(([first, mid, last]) => first + mid.join('') + last)
);

const domain = fc.array(domainLabel, { minLength: 1, maxLength: 4 }).map((ls) => ls.join('.'));

// Well-formed email comfortably within the 254-char limit.
const validEmail = fc
  .tuple(localPart, domain)
  .map(([local, dom]) => `${local}@${dom}`)
  .filter((e) => e.length <= MAX_EMAIL_LENGTH);

// Well-formed structure but longer than the documented maximum.
const overlongEmail = fc.integer({ min: MAX_EMAIL_LENGTH + 1, max: 400 }).map((total) => {
  const suffix = '@example.com';
  return 'a'.repeat(total - suffix.length) + suffix; // total characters long
});

// Strings that can never match the anchored email pattern.
const malformedEmail = fc.oneof(
  fc.constant(''), // empty
  fc.array(atextChar, { minLength: 1, maxLength: 40 }).map((cs) => cs.join('')), // no '@'
  domain.map((d) => `@${d}`), // empty local part
  localPart.map((l) => `${l}@`), // empty domain
  validEmail.map((e) => ` ${e}`), // leading space
  validEmail.map((e) => `${e} x`), // embedded space
  validEmail.map((e) => `${e}.`), // trailing dot in domain
  fc.tuple(localPart, domain).map(([l, d]) => `${l}@@${d}`) // double '@'
);

describe('Property 1 - validateEmail accepts iff well-formed and <= 254 chars (Req 1.3)', () => {
  it('accepts well-formed emails within the length limit', () => {
    fc.assert(
      fc.property(validEmail, (email) => {
        expect(email.length).toBeLessThanOrEqual(MAX_EMAIL_LENGTH);
        expect(validateEmail(email)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects well-formed emails longer than the length limit', () => {
    fc.assert(
      fc.property(overlongEmail, (email) => {
        expect(email.length).toBeGreaterThan(MAX_EMAIL_LENGTH);
        expect(validateEmail(email)).toBe(false);
      }),
      RUNS
    );
  });

  it('rejects malformed addresses regardless of length', () => {
    fc.assert(
      fc.property(malformedEmail, (email) => {
        expect(validateEmail(email)).toBe(false);
      }),
      RUNS
    );
  });
});

// --- validatePassword (Requirement 1.4) -----------------------------------

describe('Property 1 - validatePassword accepts iff length in [8, 128] (Req 1.4)', () => {
  it('accepts passwords whose length is within range', () => {
    fc.assert(
      fc.property(asciiOfLength(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH), (pw) => {
        expect(validatePassword(pw)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects passwords whose length is outside range', () => {
    const tooShort = asciiOfLength(0, MIN_PASSWORD_LENGTH - 1);
    const tooLong = asciiOfLength(MAX_PASSWORD_LENGTH + 1, MAX_PASSWORD_LENGTH + 200);
    fc.assert(
      fc.property(fc.oneof(tooShort, tooLong), (pw) => {
        expect(validatePassword(pw)).toBe(false);
      }),
      RUNS
    );
  });
});

// --- validateDailyGoal (Requirements 1.7, 1.8, 3.4, 26.2) -----------------

describe('Property 1 - validateDailyGoal accepts iff integer in [5, 120] (Req 1.7, 1.8, 3.4, 26.2)', () => {
  it('accepts integers within range', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_DAILY_GOAL, max: MAX_DAILY_GOAL }), (n) => {
        expect(validateDailyGoal(n)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects integers outside range', () => {
    const below = fc.integer({ min: MIN_DAILY_GOAL - 5000, max: MIN_DAILY_GOAL - 1 });
    const above = fc.integer({ min: MAX_DAILY_GOAL + 1, max: MAX_DAILY_GOAL + 5000 });
    fc.assert(
      fc.property(fc.oneof(below, above), (n) => {
        expect(validateDailyGoal(n)).toBe(false);
      }),
      RUNS
    );
  });

  it('rejects non-integer numbers (including in-range fractions and non-finite values)', () => {
    const fractions = fc
      .double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true })
      .filter((n) => Number.isFinite(n) && !Number.isInteger(n));
    const nonFinite = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
    fc.assert(
      fc.property(fc.oneof(fractions, nonFinite), (n) => {
        expect(validateDailyGoal(n)).toBe(false);
      }),
      RUNS
    );
  });
});

// --- validateDepth (Requirement 3.4) --------------------------------------

describe('Property 1 - validateDepth accepts iff in { quick, balanced, deep } (Req 3.4)', () => {
  it('accepts the supported depths', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DEPTHS), (d) => {
        expect(validateDepth(d)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects any other string', () => {
    const notADepth = fc.string().filter((s) => !(DEPTHS as readonly string[]).includes(s));
    fc.assert(
      fc.property(notADepth, (s) => {
        expect(validateDepth(s)).toBe(false);
      }),
      RUNS
    );
  });

  it('rejects non-string values', () => {
    const nonString = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.string())
    );
    fc.assert(
      fc.property(nonString, (v) => {
        expect(validateDepth(v)).toBe(false);
      }),
      RUNS
    );
  });
});

// --- validateDisplayName (Requirements 26.2, 26.3) ------------------------

describe('Property 1 - validateDisplayName accepts iff length in [1, 50] (Req 26.2, 26.3)', () => {
  it('accepts display names whose length is within range', () => {
    fc.assert(
      fc.property(asciiOfLength(MIN_DISPLAY_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH), (s) => {
        expect(validateDisplayName(s)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects empty and over-length display names', () => {
    const overLength = asciiOfLength(MAX_DISPLAY_NAME_LENGTH + 1, MAX_DISPLAY_NAME_LENGTH + 200);
    fc.assert(
      fc.property(fc.oneof(fc.constant(''), overLength), (s) => {
        expect(validateDisplayName(s)).toBe(false);
      }),
      RUNS
    );
  });
});

// --- validateCollectionName (Requirement 22.1) ----------------------------

describe('Property 1 - validateCollectionName accepts iff length in [1, 100] (Req 22.1)', () => {
  it('accepts collection names whose length is within range', () => {
    fc.assert(
      fc.property(asciiOfLength(MIN_COLLECTION_NAME_LENGTH, MAX_COLLECTION_NAME_LENGTH), (s) => {
        expect(validateCollectionName(s)).toBe(true);
      }),
      RUNS
    );
  });

  it('rejects empty and over-length collection names', () => {
    const overLength = asciiOfLength(MAX_COLLECTION_NAME_LENGTH + 1, MAX_COLLECTION_NAME_LENGTH + 200);
    fc.assert(
      fc.property(fc.oneof(fc.constant(''), overLength), (s) => {
        expect(validateCollectionName(s)).toBe(false);
      }),
      RUNS
    );
  });
});

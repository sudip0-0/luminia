import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  asBoolean,
  asIso,
  asIsoOrNull,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  parseVector,
  placeholders,
  serializeVector,
} from './mappers.js';

// Verifies the pure column-mapping helpers shared by the repositories.

describe('asString / asStringOrNull', () => {
  it('passes through strings and stringifies other values', () => {
    expect(asString('x')).toBe('x');
    expect(asString(42)).toBe('42');
  });

  it('throws on null/undefined for asString', () => {
    expect(() => asString(null)).toThrow();
    expect(() => asString(undefined)).toThrow();
  });

  it('maps null/undefined to null for asStringOrNull', () => {
    expect(asStringOrNull(null)).toBeNull();
    expect(asStringOrNull(undefined)).toBeNull();
    expect(asStringOrNull('y')).toBe('y');
  });
});

describe('asNumber / asNumberOrNull', () => {
  it('accepts numbers and numeric strings (pg numeric arrives as string)', () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber('0.35')).toBeCloseTo(0.35);
  });

  it('throws on non-numeric values', () => {
    expect(() => asNumber('abc')).toThrow();
    expect(() => asNumber(null)).toThrow();
  });

  it('maps null/undefined to null for asNumberOrNull', () => {
    expect(asNumberOrNull(null)).toBeNull();
    expect(asNumberOrNull('1.5')).toBeCloseTo(1.5);
  });
});

describe('asBoolean', () => {
  it('accepts booleans and pg t/f representations', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean('t')).toBe(true);
    expect(asBoolean('f')).toBe(false);
  });

  it('throws on unexpected values', () => {
    expect(() => asBoolean('maybe')).toThrow();
  });
});

describe('asIso / asIsoOrNull', () => {
  it('formats a Date as ISO-8601', () => {
    expect(asIso(new Date('2024-01-15T12:00:00.000Z'))).toBe(
      '2024-01-15T12:00:00.000Z',
    );
  });

  it('normalizes an ISO string', () => {
    expect(asIso('2024-01-15T12:00:00Z')).toBe('2024-01-15T12:00:00.000Z');
  });

  it('maps null to null for asIsoOrNull', () => {
    expect(asIsoOrNull(null)).toBeNull();
  });
});

describe('serializeVector / parseVector', () => {
  it('serializes to the pgvector literal form', () => {
    expect(serializeVector([1, 2, 3])).toBe('[1,2,3]');
  });

  it('parses the pgvector text form and passes arrays through', () => {
    expect(parseVector('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseVector([4, 5])).toEqual([4, 5]);
    expect(parseVector('[]')).toEqual([]);
    expect(parseVector(null)).toBeNull();
  });

  it('round-trips any numeric vector (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 32 }),
        (vec) => {
          expect(parseVector(serializeVector(vec))).toEqual(vec);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('placeholders', () => {
  it('builds a $1.. list from the default start', () => {
    expect(placeholders(3)).toBe('$1, $2, $3');
  });

  it('honors a custom start offset', () => {
    expect(placeholders(2, 4)).toBe('$4, $5');
  });

  it('produces sequential, distinct, 1-based placeholders (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (count, start) => {
          const parts = placeholders(count, start).split(', ');
          expect(parts).toHaveLength(count);
          parts.forEach((p, idx) => {
            expect(p).toBe(`$${start + idx}`);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

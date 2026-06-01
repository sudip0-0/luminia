import { describe, it, expect } from 'vitest';
import {
  validateEmail,
  validatePassword,
  validateDailyGoal,
  validateDepth,
  validateDisplayName,
  validateCollectionName,
} from './validators.js';

// Basic example unit tests for the pure input validators (design Property 1).
// The exhaustive property-based test lives in task 3.2.

describe('validateEmail (Requirement 1.3)', () => {
  it('accepts well-formed addresses', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('a.b+tag@sub.example.co.uk')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail('not-an-email')).toBe(false);
    expect(validateEmail('@example.com')).toBe(false);
    expect(validateEmail('user@@example.com')).toBe(false);
    expect(validateEmail('user @example.com')).toBe(false);
    expect(validateEmail('user@example.com.')).toBe(false); // trailing dot in domain
    expect(validateEmail('user@-example.com')).toBe(false); // leading hyphen in label
  });

  it('accepts a single-label domain (WHATWG/RFC-style form)', () => {
    // The design references the RFC-style / WHATWG email form, which accepts
    // domains without a dot (e.g. intranet hosts).
    expect(validateEmail('user@localhost')).toBe(true);
  });

  it('rejects addresses longer than 254 characters', () => {
    const local = 'a'.repeat(250);
    const tooLong = `${local}@ex.com`; // 250 + 7 = 257 chars
    expect(tooLong.length).toBeGreaterThan(254);
    expect(validateEmail(tooLong)).toBe(false);
  });

  it('accepts an address at exactly 254 characters', () => {
    // local part sized so that total length === 254
    const domain = '@example.com'; // 12 chars
    const local = 'a'.repeat(254 - domain.length);
    const email = `${local}${domain}`;
    expect(email.length).toBe(254);
    expect(validateEmail(email)).toBe(true);
  });
});

describe('validatePassword (Requirement 1.4)', () => {
  it('accepts lengths within [8, 128]', () => {
    expect(validatePassword('a'.repeat(8))).toBe(true);
    expect(validatePassword('a'.repeat(64))).toBe(true);
    expect(validatePassword('a'.repeat(128))).toBe(true);
  });

  it('rejects lengths outside [8, 128]', () => {
    expect(validatePassword('a'.repeat(7))).toBe(false);
    expect(validatePassword('a'.repeat(129))).toBe(false);
    expect(validatePassword('')).toBe(false);
  });
});

describe('validateDailyGoal (Requirements 1.7, 1.8, 3.4, 26.2)', () => {
  it('accepts integers within [5, 120]', () => {
    expect(validateDailyGoal(5)).toBe(true);
    expect(validateDailyGoal(15)).toBe(true);
    expect(validateDailyGoal(120)).toBe(true);
  });

  it('rejects values outside [5, 120]', () => {
    expect(validateDailyGoal(4)).toBe(false);
    expect(validateDailyGoal(121)).toBe(false);
    expect(validateDailyGoal(0)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validateDailyGoal(15.5)).toBe(false);
    expect(validateDailyGoal(Number.NaN)).toBe(false);
    expect(validateDailyGoal(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('validateDepth (Requirement 3.4)', () => {
  it('accepts the three supported depths', () => {
    expect(validateDepth('quick')).toBe(true);
    expect(validateDepth('balanced')).toBe(true);
    expect(validateDepth('deep')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(validateDepth('shallow')).toBe(false);
    expect(validateDepth('')).toBe(false);
    expect(validateDepth(undefined)).toBe(false);
    expect(validateDepth(42)).toBe(false);
  });
});

describe('validateDisplayName (Requirements 26.2, 26.3)', () => {
  it('accepts lengths within [1, 50]', () => {
    expect(validateDisplayName('a')).toBe(true);
    expect(validateDisplayName('a'.repeat(50))).toBe(true);
  });

  it('rejects empty and over-length names', () => {
    expect(validateDisplayName('')).toBe(false);
    expect(validateDisplayName('a'.repeat(51))).toBe(false);
  });
});

describe('validateCollectionName (Requirement 22.1)', () => {
  it('accepts lengths within [1, 100]', () => {
    expect(validateCollectionName('a')).toBe(true);
    expect(validateCollectionName('a'.repeat(100))).toBe(true);
  });

  it('rejects empty and over-length names', () => {
    expect(validateCollectionName('')).toBe(false);
    expect(validateCollectionName('a'.repeat(101))).toBe(false);
  });
});

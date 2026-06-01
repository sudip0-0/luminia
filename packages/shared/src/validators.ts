// Pure input validators.
//
// Mirrors the "Validation" subsection of the Auth_Service in the design
// document and Property 1 ("Input validators accept exactly the allowed
// ranges"). Each validator is a pure, side-effect-free predicate that accepts
// a candidate value if and only if it lies within its documented range. These
// functions are reused by registration, onboarding, and profile update, and
// are imported by the API.
//
// Validates (design Property 1): Requirements 1.3, 1.4, 1.7, 1.8, 3.4, 22.1,
// 26.2, 26.3.

import { DEPTHS, type Depth } from './domain.js';

/** Maximum total length of an email address (Requirement 1.3). */
export const MAX_EMAIL_LENGTH = 254;

/** Inclusive password length bounds (Requirements 1.4). */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** Inclusive Daily_Goal bounds, in minutes (Requirements 1.7, 1.8, 3.4, 26.2). */
export const MIN_DAILY_GOAL = 5;
export const MAX_DAILY_GOAL = 120;

/** Inclusive display-name length bounds (Requirements 26.2, 26.3). */
export const MIN_DISPLAY_NAME_LENGTH = 1;
export const MAX_DISPLAY_NAME_LENGTH = 50;

/** Inclusive collection-name length bounds (Requirement 22.1). */
export const MIN_COLLECTION_NAME_LENGTH = 1;
export const MAX_COLLECTION_NAME_LENGTH = 100;

/**
 * RFC-style ("dot-atom" form) email pattern. This is the WHATWG HTML5
 * `<input type="email">` pattern: a local part of atext characters, an `@`,
 * and a domain of dot-separated hostname labels (each 1-63 chars, no leading
 * or trailing hyphen). It is a pragmatic, widely-adopted approximation of RFC
 * 5322 and intentionally does not accept quoted local parts or IP-literal
 * domains.
 */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Accepts iff `email` is a well-formed email address whose total length is at
 * most {@link MAX_EMAIL_LENGTH} (254) characters (Requirement 1.3).
 */
export function validateEmail(email: string): boolean {
  return (
    typeof email === 'string' &&
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(email)
  );
}

/**
 * Accepts iff the password length is in the inclusive range
 * [{@link MIN_PASSWORD_LENGTH}, {@link MAX_PASSWORD_LENGTH}] = [8, 128]
 * (Requirement 1.4).
 */
export function validatePassword(pw: string): boolean {
  return (
    typeof pw === 'string' &&
    pw.length >= MIN_PASSWORD_LENGTH &&
    pw.length <= MAX_PASSWORD_LENGTH
  );
}

/**
 * Accepts iff `n` is an integer in the inclusive range
 * [{@link MIN_DAILY_GOAL}, {@link MAX_DAILY_GOAL}] = [5, 120]
 * (Requirements 1.7, 1.8, 3.4, 26.2, 26.3).
 */
export function validateDailyGoal(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_DAILY_GOAL && n <= MAX_DAILY_GOAL;
}

/**
 * Accepts iff `d` is one of the supported reading depths
 * ({@link DEPTHS} = quick | balanced | deep). Acts as a type guard narrowing
 * to {@link Depth} (Requirements 3.4, 26.2, 26.3).
 */
export function validateDepth(d: unknown): d is Depth {
  return typeof d === 'string' && (DEPTHS as readonly string[]).includes(d);
}

/**
 * Accepts iff the display name length is in the inclusive range
 * [{@link MIN_DISPLAY_NAME_LENGTH}, {@link MAX_DISPLAY_NAME_LENGTH}] = [1, 50]
 * (Requirements 26.2, 26.3).
 */
export function validateDisplayName(s: string): boolean {
  return (
    typeof s === 'string' &&
    s.length >= MIN_DISPLAY_NAME_LENGTH &&
    s.length <= MAX_DISPLAY_NAME_LENGTH
  );
}

/**
 * Accepts iff the collection name length is in the inclusive range
 * [{@link MIN_COLLECTION_NAME_LENGTH}, {@link MAX_COLLECTION_NAME_LENGTH}]
 * = [1, 100] (Requirement 22.1).
 */
export function validateCollectionName(s: string): boolean {
  return (
    typeof s === 'string' &&
    s.length >= MIN_COLLECTION_NAME_LENGTH &&
    s.length <= MAX_COLLECTION_NAME_LENGTH
  );
}

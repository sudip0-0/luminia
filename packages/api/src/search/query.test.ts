import { describe, it, expect } from 'vitest';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  validateSearchQuery,
} from './query.js';

// Verifies the query-length validation boundaries used by the Search_Service:
// only a trimmed length in [1, 200] is searchable; empty, whitespace-only, and
// oversized queries are rejected (Requirement 20.5).

describe('validateSearchQuery', () => {
  it('rejects an empty query', () => {
    expect(validateSearchQuery('')).toBe(false);
  });

  it('rejects a whitespace-only query', () => {
    expect(validateSearchQuery('   ')).toBe(false);
    expect(validateSearchQuery('\t\n  ')).toBe(false);
  });

  it('accepts the minimum-length boundary (1 char after trim)', () => {
    expect(SEARCH_QUERY_MIN_LENGTH).toBe(1);
    expect(validateSearchQuery('a')).toBe(true);
    expect(validateSearchQuery('  a  ')).toBe(true);
  });

  it('accepts a typical query', () => {
    expect(validateSearchQuery('quantum computing')).toBe(true);
  });

  it('accepts exactly the maximum length (200 chars after trim)', () => {
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(200);
    const maxQuery = 'x'.repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(validateSearchQuery(maxQuery)).toBe(true);
    // Surrounding whitespace does not count toward the limit.
    expect(validateSearchQuery(`  ${maxQuery}  `)).toBe(true);
  });

  it('rejects a query one character over the maximum', () => {
    expect(validateSearchQuery('x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1))).toBe(
      false,
    );
  });
});

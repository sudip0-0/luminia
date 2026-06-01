// Search query validation (Requirement 20.5).
//
// PURE: no I/O, so the length boundaries are exhaustively unit-testable. The
// Search_Service rejects an empty, whitespace-only, or oversized query with a
// validation error and never performs the search; only a query whose trimmed
// length is in [1, 200] is searchable (Requirements 20.4, 20.5).

/** Minimum trimmed length of a searchable query (Requirement 20.5). */
export const SEARCH_QUERY_MIN_LENGTH = 1;

/** Maximum trimmed length of a searchable query (Requirement 20.5). */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * Whether `q` is a searchable query: its trimmed length must fall within
 * [{@link SEARCH_QUERY_MIN_LENGTH}, {@link SEARCH_QUERY_MAX_LENGTH}].
 *
 * Trimming first means an empty or whitespace-only query collapses to length 0
 * and is rejected, while a query longer than the maximum (after trimming) is
 * also rejected (Requirement 20.5).
 */
export function validateSearchQuery(q: string): boolean {
  const length = q.trim().length;
  return length >= SEARCH_QUERY_MIN_LENGTH && length <= SEARCH_QUERY_MAX_LENGTH;
}

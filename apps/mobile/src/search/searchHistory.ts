// Mobile_App local search history (Requirement 20.8).
//
// Non-empty queries are stored in a local history that is:
//   - bounded to at most 50 entries (oldest evicted on overflow),
//   - unique (a re-searched query is de-duplicated, not duplicated), and
//   - recency-ordered (most-recent first).
//
// A pure value-to-value transform so the bound/uniqueness/ordering invariants
// are property-testable without any storage.

/** Maximum number of stored search-history entries (Requirement 20.8). */
export const MAX_SEARCH_HISTORY = 50;

/**
 * Add a query to the search history, returning the new history (most-recent
 * first). An empty/whitespace-only query is ignored (history unchanged). A query
 * already present is moved to the front rather than duplicated, and the list is
 * capped at {@link MAX_SEARCH_HISTORY} by evicting the oldest entries.
 *
 * Pure: never mutates `history`.
 */
export function addSearchQuery(history: readonly string[], query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [...history];
  const withoutDuplicate = history.filter((q) => q !== trimmed);
  return [trimmed, ...withoutDuplicate].slice(0, MAX_SEARCH_HISTORY);
}

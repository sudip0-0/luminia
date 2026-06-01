// Mobile_App Reader — "Go deeper" related-articles gating (Requirements 19.4,
// 19.5).
//
// The Reader presents a "Go deeper" section only when at least
// {@link GO_DEEPER_MIN_RELATED} related articles are available, and then shows
// at most {@link GO_DEEPER_MAX_SHOWN} of them (min(n, 5)); when fewer than the
// threshold are available the section is omitted entirely.
//
// Pure decision function so the threshold/cap is property-testable.

/** Minimum related-article count to show the "Go deeper" section (Requirement 19.4). */
export const GO_DEEPER_MIN_RELATED = 3;

/** Maximum related articles shown in the "Go deeper" section (Requirement 19.4). */
export const GO_DEEPER_MAX_SHOWN = 5;

/** The Reader's decision about the "Go deeper" section. */
export interface GoDeeperDecision {
  /** Whether to render the section at all (Requirement 19.5: omit when n < 3). */
  show: boolean;
  /** How many related articles to display: min(n, 5) when shown, else 0. */
  shownCount: number;
}

/**
 * Decide whether to show the "Go deeper" section and how many related articles
 * to display, given the number of available related articles `n`
 * (Requirements 19.4, 19.5). Negative or non-integer inputs are floored to 0.
 */
export function goDeeperDecision(relatedCount: number): GoDeeperDecision {
  const n = Number.isFinite(relatedCount) ? Math.max(0, Math.floor(relatedCount)) : 0;
  if (n < GO_DEEPER_MIN_RELATED) return { show: false, shownCount: 0 };
  return { show: true, shownCount: Math.min(n, GO_DEEPER_MAX_SHOWN) };
}

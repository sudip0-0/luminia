// Mobile_App onboarding flow gating (Requirements 4.2, 4.3).
//
// The onboarding flow disables the advance control until the user has selected
// at least 3 topics and exactly one Depth_Preference. The six content sources
// default to enabled and are retained on skip (Requirement 4.4) — modelled here
// as the default selection helper.
//
// Pure helpers so the gating is unit-testable without the UI.

import type { Depth, Source } from '@lumina/shared';

/** Minimum number of topics required to advance past topic selection (Req 4.2). */
export const MIN_ONBOARDING_TOPICS = 3;

/** Maximum number of topics accepted during onboarding (Requirement 3.4 range 3-20). */
export const MAX_ONBOARDING_TOPICS = 20;

/** The six content sources, enabled by default at onboarding (Requirement 4.4). */
export const DEFAULT_ENABLED_SOURCES: readonly Source[] = [
  'wikipedia',
  'hacker_news',
  'medium',
  'arxiv',
  'mit_news',
  'quanta',
];

/** The current onboarding selection state. */
export interface OnboardingSelection {
  /** Distinct selected topic ids. */
  topicIds: readonly string[];
  /** The selected Depth_Preference, or null when none is chosen yet. */
  depth: Depth | null;
}

/**
 * Whether the onboarding advance control should be enabled: at least
 * {@link MIN_ONBOARDING_TOPICS} (and at most {@link MAX_ONBOARDING_TOPICS})
 * distinct topics are selected and exactly one depth is chosen
 * (Requirements 4.2, 4.3).
 */
export function canAdvanceOnboarding(selection: OnboardingSelection): boolean {
  const distinct = new Set(selection.topicIds).size;
  return (
    distinct >= MIN_ONBOARDING_TOPICS &&
    distinct <= MAX_ONBOARDING_TOPICS &&
    selection.depth !== null
  );
}

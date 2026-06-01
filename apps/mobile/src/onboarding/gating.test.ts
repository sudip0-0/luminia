import { describe, it, expect } from 'vitest';

import {
  canAdvanceOnboarding,
  DEFAULT_ENABLED_SOURCES,
  MIN_ONBOARDING_TOPICS,
} from './gating.js';

// Onboarding advance gating (Requirements 4.2, 4.3, 4.4).

describe('canAdvanceOnboarding (Req 4.2, 4.3)', () => {
  it('blocks advance with fewer than 3 topics', () => {
    expect(canAdvanceOnboarding({ topicIds: ['a', 'b'], depth: 'balanced' })).toBe(false);
  });

  it('blocks advance when no depth is selected', () => {
    expect(canAdvanceOnboarding({ topicIds: ['a', 'b', 'c'], depth: null })).toBe(false);
  });

  it('enables advance with >=3 distinct topics and exactly one depth', () => {
    expect(canAdvanceOnboarding({ topicIds: ['a', 'b', 'c'], depth: 'deep' })).toBe(true);
  });

  it('counts only distinct topics toward the minimum', () => {
    expect(canAdvanceOnboarding({ topicIds: ['a', 'a', 'b'], depth: 'quick' })).toBe(false);
    expect(MIN_ONBOARDING_TOPICS).toBe(3);
  });

  it('blocks advance beyond 20 topics', () => {
    const topics = Array.from({ length: 21 }, (_, i) => `t-${i}`);
    expect(canAdvanceOnboarding({ topicIds: topics, depth: 'balanced' })).toBe(false);
  });

  it('defaults all six content sources to enabled', () => {
    expect(DEFAULT_ENABLED_SOURCES).toHaveLength(6);
  });
});

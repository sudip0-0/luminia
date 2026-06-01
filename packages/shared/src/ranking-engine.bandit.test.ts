import { describe, it, expect } from 'vitest';
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from './ranking.js';
import {
  MAX_BANDIT_RELEVANCE_ADJUSTMENT,
  applyBanditTuning,
} from './ranking-engine.js';

// Example unit tests for bandit weight tuning with re-normalization (task 11.5).
// The exhaustive property test "weights always sum to 1.0" lives in task 11.6.

function sum(weights: RankingWeights): number {
  return (
    weights.relevance +
    weights.novelty +
    weights.quality +
    weights.recency +
    weights.diversity +
    weights.serendipity
  );
}

describe('applyBanditTuning (Requirement 9.6)', () => {
  it('leaves the weights effectively unchanged with a zero adjustment', () => {
    const tuned = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, 0);
    // Defaults already sum to 1.0, so re-normalization is the identity.
    expect(tuned.relevance).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.relevance, 10);
    expect(tuned.novelty).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.novelty, 10);
    expect(tuned.quality).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.quality, 10);
    expect(tuned.recency).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.recency, 10);
    expect(tuned.diversity).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.diversity, 10);
    expect(tuned.serendipity).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.serendipity, 10);
    expect(sum(tuned)).toBeCloseTo(1, 10);
  });

  it('increases the relevance share and re-normalizes to sum 1.0', () => {
    const tuned = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, 0.15);
    expect(tuned.relevance).toBeGreaterThan(DEFAULT_RANKING_WEIGHTS.relevance);
    expect(sum(tuned)).toBeCloseTo(1, 10);
  });

  it('re-normalizes the non-relevance weights downward to preserve the sum', () => {
    const tuned = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, 0.15);
    // Boosting relevance and dividing by the larger total shrinks the others.
    expect(tuned.novelty).toBeLessThan(DEFAULT_RANKING_WEIGHTS.novelty);
    expect(tuned.quality).toBeLessThan(DEFAULT_RANKING_WEIGHTS.quality);
    expect(tuned.recency).toBeLessThan(DEFAULT_RANKING_WEIGHTS.recency);
    expect(tuned.diversity).toBeLessThan(DEFAULT_RANKING_WEIGHTS.diversity);
    expect(tuned.serendipity).toBeLessThan(DEFAULT_RANKING_WEIGHTS.serendipity);
  });

  it('clamps an over-large adjustment to the 0.15 maximum', () => {
    const clamped = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, 5);
    const atMax = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, MAX_BANDIT_RELEVANCE_ADJUSTMENT);
    expect(clamped.relevance).toBeCloseTo(atMax.relevance, 10);
    expect(sum(clamped)).toBeCloseTo(1, 10);
  });

  it('clamps a negative adjustment to 0 (no boost)', () => {
    const clamped = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, -1);
    const zero = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, 0);
    expect(clamped.relevance).toBeCloseTo(zero.relevance, 10);
    expect(sum(clamped)).toBeCloseTo(1, 10);
  });

  it('treats NaN as no boost', () => {
    const tuned = applyBanditTuning(DEFAULT_RANKING_WEIGHTS, Number.NaN);
    expect(tuned.relevance).toBeCloseTo(DEFAULT_RANKING_WEIGHTS.relevance, 10);
    expect(sum(tuned)).toBeCloseTo(1, 10);
  });

  it('re-normalizes an unnormalized weight set to sum 1.0', () => {
    const unnormalized: RankingWeights = {
      relevance: 2,
      novelty: 1,
      quality: 1,
      recency: 1,
      diversity: 0.5,
      serendipity: 0.5,
    };
    const tuned = applyBanditTuning(unnormalized, 0.1);
    expect(sum(tuned)).toBeCloseTo(1, 10);
  });

  it('is pure: it does not mutate the input weights', () => {
    const input: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS };
    const snapshot = { ...input };
    applyBanditTuning(input, 0.15);
    expect(input).toEqual(snapshot);
  });

  it('returns a copy of degenerate all-zero weights instead of NaN', () => {
    const zeroes: RankingWeights = {
      relevance: 0,
      novelty: 0,
      quality: 0,
      recency: 0,
      diversity: 0,
      serendipity: 0,
    };
    const tuned = applyBanditTuning(zeroes, 0);
    expect(tuned).toEqual(zeroes);
    for (const value of Object.values(tuned)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

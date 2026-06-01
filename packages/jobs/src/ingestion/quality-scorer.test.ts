import { describe, it, expect } from 'vitest';
import { SOURCES, type Source } from '@lumina/shared';
import {
  QUALITY_THRESHOLD,
  QUALITY_WEIGHTS,
  SOURCE_TIER_WEIGHTS,
  LENGTH_HALF_SATURATION_WORDS,
  IDEAL_GRADE_MIN,
  IDEAL_GRADE_MAX,
  GRADE_FALLOFF,
  lengthSubscore,
  readingLevelSubscore,
  sourceTierSubscore,
  scoreQuality,
  meetsQualityThreshold,
  type QualityScoreInput,
} from './quality-scorer.js';

describe('QUALITY_WEIGHTS', () => {
  it('are non-negative and sum to exactly 1.0', () => {
    const { length, readingLevel, sourceTier } = QUALITY_WEIGHTS;
    expect(length).toBeGreaterThanOrEqual(0);
    expect(readingLevel).toBeGreaterThanOrEqual(0);
    expect(sourceTier).toBeGreaterThanOrEqual(0);
    expect(length + readingLevel + sourceTier).toBeCloseTo(1, 10);
  });
});

describe('lengthSubscore (content length with diminishing returns)', () => {
  it('is 0 for empty or non-positive content', () => {
    expect(lengthSubscore(0)).toBe(0);
    expect(lengthSubscore(-100)).toBe(0);
  });

  it('treats non-finite word counts as no content', () => {
    expect(lengthSubscore(Number.NaN)).toBe(0);
    expect(lengthSubscore(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('reaches 0.5 at the half-saturation word count', () => {
    expect(lengthSubscore(LENGTH_HALF_SATURATION_WORDS)).toBeCloseTo(0.5, 10);
  });

  it('is monotonically non-decreasing in word count and bounded below 1', () => {
    const small = lengthSubscore(100);
    const medium = lengthSubscore(1000);
    const large = lengthSubscore(100_000);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    expect(large).toBeLessThan(1);
  });
});

describe('readingLevelSubscore (reading level band)', () => {
  it('awards the full score within the ideal grade band (inclusive)', () => {
    expect(readingLevelSubscore(IDEAL_GRADE_MIN)).toBe(1);
    expect(readingLevelSubscore(IDEAL_GRADE_MAX)).toBe(1);
    expect(readingLevelSubscore((IDEAL_GRADE_MIN + IDEAL_GRADE_MAX) / 2)).toBe(1);
  });

  it('decays linearly below the band and floors at 0', () => {
    expect(readingLevelSubscore(IDEAL_GRADE_MIN - GRADE_FALLOFF / 2)).toBeCloseTo(0.5, 10);
    expect(readingLevelSubscore(IDEAL_GRADE_MIN - GRADE_FALLOFF)).toBe(0);
    expect(readingLevelSubscore(IDEAL_GRADE_MIN - GRADE_FALLOFF * 2)).toBe(0);
  });

  it('decays linearly above the band and floors at 0', () => {
    expect(readingLevelSubscore(IDEAL_GRADE_MAX + GRADE_FALLOFF / 2)).toBeCloseTo(0.5, 10);
    expect(readingLevelSubscore(IDEAL_GRADE_MAX + GRADE_FALLOFF)).toBe(0);
    expect(readingLevelSubscore(IDEAL_GRADE_MAX + GRADE_FALLOFF * 2)).toBe(0);
  });

  it('treats non-finite grades as outside the band', () => {
    expect(readingLevelSubscore(Number.NaN)).toBe(0);
    expect(readingLevelSubscore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('sourceTierSubscore (each source tier)', () => {
  it('maps every supported source to its configured tier weight in [0,1]', () => {
    for (const source of SOURCES) {
      const value = sourceTierSubscore(source);
      expect(value).toBe(SOURCE_TIER_WEIGHTS[source]);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('assigns the expected tier for each of the six sources', () => {
    expect(sourceTierSubscore('quanta')).toBe(1.0);
    expect(sourceTierSubscore('mit_news')).toBe(1.0);
    expect(sourceTierSubscore('wikipedia')).toBe(0.7);
    expect(sourceTierSubscore('arxiv')).toBe(0.7);
    expect(sourceTierSubscore('hacker_news')).toBe(0.4);
    expect(sourceTierSubscore('medium')).toBe(0.4);
  });
});

describe('scoreQuality (bounded composite score)', () => {
  it('hits the composite floor for the minimum-content article (no words, worst reading level, lowest tier)', () => {
    const score = scoreQuality({
      source: 'medium',
      wordCount: 0,
      readingGradeLevel: IDEAL_GRADE_MAX + GRADE_FALLOFF * 5,
    });
    // Length and reading sub-scores are 0; only the lowest source tier
    // contributes, so the composite floor is QUALITY_WEIGHTS.sourceTier * 0.4.
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeCloseTo(QUALITY_WEIGHTS.sourceTier * SOURCE_TIER_WEIGHTS.medium, 10);
    expect(meetsQualityThreshold(score)).toBe(false);
  });

  it('approaches but never exceeds 1 for the maximum-content article', () => {
    const score = scoreQuality({
      source: 'quanta',
      wordCount: 1_000_000,
      readingGradeLevel: (IDEAL_GRADE_MIN + IDEAL_GRADE_MAX) / 2,
    });
    expect(score).toBeLessThanOrEqual(1);
    // length sub-score asymptotes below 1, so the composite stays below 1.
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  it('stays within [0,1] across each source tier with rich content', () => {
    for (const source of SOURCES) {
      const score = scoreQuality({
        source,
        wordCount: 1200,
        readingGradeLevel: 11,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('clamps to [0,1] even with adversarial inputs', () => {
    const negative = scoreQuality({
      source: 'medium',
      wordCount: Number.NEGATIVE_INFINITY,
      readingGradeLevel: Number.NaN,
    });
    expect(negative).toBeGreaterThanOrEqual(0);
    expect(negative).toBeLessThanOrEqual(1);
  });

  it('ranks a higher tier above a lower tier when other signals are equal', () => {
    const common = { wordCount: 800, readingGradeLevel: 10 } as const;
    const quanta = scoreQuality({ source: 'quanta', ...common });
    const wikipedia = scoreQuality({ source: 'wikipedia', ...common });
    const medium = scoreQuality({ source: 'medium', ...common });
    expect(quanta).toBeGreaterThan(wikipedia);
    expect(wikipedia).toBeGreaterThan(medium);
  });
});

describe('meetsQualityThreshold (storage gate at 0.3)', () => {
  it('uses 0.3 as the threshold constant', () => {
    expect(QUALITY_THRESHOLD).toBe(0.3);
  });

  it('permits storage exactly at and above the threshold', () => {
    expect(meetsQualityThreshold(0.3)).toBe(true);
    expect(meetsQualityThreshold(0.30000001)).toBe(true);
    expect(meetsQualityThreshold(1)).toBe(true);
  });

  it('blocks storage strictly below the threshold', () => {
    expect(meetsQualityThreshold(0.29999999)).toBe(false);
    expect(meetsQualityThreshold(0)).toBe(false);
    expect(meetsQualityThreshold(-1)).toBe(false);
  });

  it('agrees with scoreQuality on real boundary inputs', () => {
    // A low-tier article with thin content and poor reading level falls below 0.3.
    const reject: QualityScoreInput = {
      source: 'medium',
      wordCount: 20,
      readingGradeLevel: IDEAL_GRADE_MAX + GRADE_FALLOFF,
    };
    const rejectScore = scoreQuality(reject);
    expect(rejectScore).toBeLessThan(QUALITY_THRESHOLD);
    expect(meetsQualityThreshold(rejectScore)).toBe(false);

    // A top-tier, well-pitched, substantial article clears the gate.
    const accept: QualityScoreInput = {
      source: 'quanta',
      wordCount: 900,
      readingGradeLevel: 11,
    };
    const acceptScore = scoreQuality(accept);
    expect(acceptScore).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
    expect(meetsQualityThreshold(acceptScore)).toBe(true);
  });

  it('finds an input whose score lands at the storage boundary region', () => {
    // Wikipedia (tier 0.7) contributes 0.3 * 0.7 = 0.21 from tier alone; with no
    // length and worst reading level the composite equals exactly 0.21 < 0.3.
    const tierOnly: Source = 'wikipedia';
    const score = scoreQuality({
      source: tierOnly,
      wordCount: 0,
      readingGradeLevel: IDEAL_GRADE_MIN - GRADE_FALLOFF,
    });
    expect(score).toBeCloseTo(QUALITY_WEIGHTS.sourceTier * SOURCE_TIER_WEIGHTS[tierOnly], 10);
    expect(meetsQualityThreshold(score)).toBe(false);
  });
});

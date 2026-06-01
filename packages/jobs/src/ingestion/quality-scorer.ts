// Quality_Scorer — assigns each ingested Article a bounded quality score and
// gates storage on a fixed threshold. (Requirements 6.3, 6.4; Property 6.)
//
// The score is a pure, deterministic, bounded function of three signals:
//   1. content length  — longer (cleaned) bodies score higher, with
//                          diminishing returns so length cannot dominate;
//   2. reading level    — a readability grade band; content pitched neither
//                          trivially low nor impenetrably high scores highest;
//   3. source tier      — a fixed mapping from each of the six Sources to a
//                          trust weight.
//
// Each signal yields a sub-score in [0, 1]; the final score is their weighted
// sum (weights sum to 1) clamped to [0, 1]. Articles scoring below
// QUALITY_THRESHOLD (0.3) are rejected and blocked from storage.

import type { Source } from '@lumina/shared';

/**
 * Storage gate threshold. An Article is permitted to be stored if and only if
 * its quality score is greater than or equal to this value (Requirement 6.4,
 * Property 6).
 */
export const QUALITY_THRESHOLD = 0.3;

/**
 * Relative contribution of each signal to the final quality score. The three
 * weights are non-negative and sum to exactly 1.0, so a weighted sum of three
 * sub-scores in [0, 1] is itself in [0, 1].
 */
export const QUALITY_WEIGHTS = {
  /** Weight of the content-length sub-score. */
  length: 0.4,
  /** Weight of the reading-level sub-score. */
  readingLevel: 0.3,
  /** Weight of the source-tier sub-score. */
  sourceTier: 0.3,
} as const;

/**
 * Word count at which the content-length sub-score reaches 0.5. The sub-score
 * approaches (but never reaches) 1.0 as length grows, giving longer bodies
 * diminishing marginal returns.
 */
export const LENGTH_HALF_SATURATION_WORDS = 500;

/** Inclusive reading-grade band that earns the full reading-level sub-score. */
export const IDEAL_GRADE_MIN = 8;
export const IDEAL_GRADE_MAX = 14;

/**
 * Grade-level distance from the ideal band at which the reading-level sub-score
 * decays linearly to 0.
 */
export const GRADE_FALLOFF = 10;

/**
 * Trust weight in [0, 1] for each Source. Higher tiers reflect more heavily
 * curated or edited provenance:
 *   - 1.0: editorially curated science journalism (Quanta, MIT News)
 *   - 0.7: reference / peer-archived sources (Wikipedia, arXiv)
 *   - 0.4: community / open-platform sources (Hacker News, Medium)
 */
export const SOURCE_TIER_WEIGHTS: Readonly<Record<Source, number>> = {
  quanta: 1.0,
  mit_news: 1.0,
  wikipedia: 0.7,
  arxiv: 0.7,
  hacker_news: 0.4,
  medium: 0.4,
};

/** Inputs from which a quality score is derived. */
export interface QualityScoreInput {
  /** The Article's Source, used to look up its source-tier weight. */
  source: Source;
  /**
   * Number of words in the cleaned full text. Non-finite or negative values
   * are treated as 0 (no content).
   */
  wordCount: number;
  /**
   * A readability grade level for the cleaned full text (approximately a US
   * school grade, e.g. a Flesch-Kincaid grade). Non-finite values are treated
   * as outside the ideal band (sub-score 0).
   */
  readingGradeLevel: number;
}

/** Clamps `value` into the inclusive range [`min`, `max`]; maps NaN to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamps `value` into the inclusive range [0, 1]. */
function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Content-length sub-score in [0, 1) with diminishing returns:
 * `words / (words + LENGTH_HALF_SATURATION_WORDS)`. Zero or fewer words yields
 * 0; the score reaches 0.5 at {@link LENGTH_HALF_SATURATION_WORDS} words and
 * asymptotically approaches 1.0 for very long bodies.
 */
export function lengthSubscore(wordCount: number): number {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return 0;
  return clamp01(wordCount / (wordCount + LENGTH_HALF_SATURATION_WORDS));
}

/**
 * Reading-level sub-score in [0, 1]. Grades within the ideal band
 * [{@link IDEAL_GRADE_MIN}, {@link IDEAL_GRADE_MAX}] earn the full 1.0; outside
 * the band the score decays linearly with grade-level distance, reaching 0 at
 * {@link GRADE_FALLOFF} grades beyond either edge.
 */
export function readingLevelSubscore(readingGradeLevel: number): number {
  if (!Number.isFinite(readingGradeLevel)) return 0;
  if (readingGradeLevel < IDEAL_GRADE_MIN) {
    return clamp01(1 - (IDEAL_GRADE_MIN - readingGradeLevel) / GRADE_FALLOFF);
  }
  if (readingGradeLevel > IDEAL_GRADE_MAX) {
    return clamp01(1 - (readingGradeLevel - IDEAL_GRADE_MAX) / GRADE_FALLOFF);
  }
  return 1;
}

/** Source-tier sub-score in [0, 1] from the fixed {@link SOURCE_TIER_WEIGHTS} map. */
export function sourceTierSubscore(source: Source): number {
  return clamp01(SOURCE_TIER_WEIGHTS[source] ?? 0);
}

/**
 * Assigns a quality score strictly within [0.0, 1.0], derived from content
 * length, reading level, and source tier as a weighted sum of three sub-scores
 * (Requirement 6.3, Property 6). The result is clamped to [0, 1] so it is
 * always bounded regardless of input.
 */
export function scoreQuality(input: QualityScoreInput): number {
  const length = lengthSubscore(input.wordCount);
  const reading = readingLevelSubscore(input.readingGradeLevel);
  const tier = sourceTierSubscore(input.source);

  const score =
    QUALITY_WEIGHTS.length * length +
    QUALITY_WEIGHTS.readingLevel * reading +
    QUALITY_WEIGHTS.sourceTier * tier;

  return clamp01(score);
}

/**
 * Returns whether a quality score is high enough to permit storage: `true` if
 * and only if `score >= QUALITY_THRESHOLD` (Requirement 6.4, Property 6).
 */
export function meetsQualityThreshold(score: number): boolean {
  return score >= QUALITY_THRESHOLD;
}

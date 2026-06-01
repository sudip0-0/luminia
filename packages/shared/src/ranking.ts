// Ranking_Engine value types.
//
// Mirrors the "Ranking_Engine" subsection of "Components and Interfaces" in the
// design document. The Ranking_Engine is a pure scoring library; these types
// describe the six normalized components of a score and the weights applied to
// them (Requirement 9).

/**
 * The six normalized ranking components, each in [0.0, 1.0]
 * (Requirements 9.1, 9.2, 9.3, 9.5).
 */
export interface RankingComponents {
  relevance: number;
  novelty: number;
  quality: number;
  recency: number;
  diversity: number;
  serendipity: number;
}

/**
 * Per-component weights applied to the {@link RankingComponents}. The six
 * weights sum to 1.0 (Requirements 9.4, 9.6).
 */
export interface RankingWeights {
  relevance: number;
  novelty: number;
  quality: number;
  recency: number;
  diversity: number;
  serendipity: number;
}

/**
 * Default component weights (Requirement 9.4):
 * relevance 0.35, novelty 0.20, quality 0.20, recency 0.15,
 * diversity 0.05, serendipity 0.05.
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  relevance: 0.35,
  novelty: 0.2,
  quality: 0.2,
  recency: 0.15,
  diversity: 0.05,
  serendipity: 0.05,
};

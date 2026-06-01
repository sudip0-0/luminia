// Core domain types for Lumina.
//
// Mirrors the "Key Data Types (TypeScript)" section of the design document.
// The allowed value sets are declared once as readonly tuples so they can be
// reused at runtime (e.g. validating a Feed_Event type against the allowed
// set — Requirements 12, 13.2) and the corresponding union types are derived
// from them, keeping a single source of truth.

/** External content providers (Requirement 5.1). */
export const SOURCES = [
  'wikipedia',
  'medium',
  'hacker_news',
  'arxiv',
  'mit_news',
  'quanta',
] as const;

/** An external content provider; one of the six supported sources. */
export type Source = (typeof SOURCES)[number];

/** Article difficulty levels (Requirement 7.1). */
export const DIFFICULTIES = ['introductory', 'intermediate', 'advanced'] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

/** User reading-depth preference (Requirement 3.4). */
export const DEPTHS = ['quick', 'balanced', 'deep'] as const;

export type Depth = (typeof DEPTHS)[number];

/**
 * The complete set of implicit/explicit behaviour signal types
 * (Requirement 12, validated by Feed_Event_Service per Requirement 13.2).
 */
export const FEED_EVENT_TYPES = [
  'impression',
  'dwell',
  'expand',
  'scroll_depth',
  'save',
  'unsave',
  'share',
  'link_out',
  'skip',
  'mute_topic',
  'session_end',
] as const;

export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

/** Association between an Article and a Topic with a confidence in [0,1]. */
export interface ArticleTopicAssociation {
  topicId: string;
  /** Confidence of the association, normalized to [0.0, 1.0]. */
  confidence: number;
}

/** A single ingested content item with metadata, summary, full text, and embedding. */
export interface Article {
  id: string;
  url: string;
  source: Source;
  title: string;
  /** Null while the article is unsummarized. */
  summary: string | null;
  /** Cleaned full text; null when the reader should fall back to an external link. */
  fullText: string | null;
  /** 1536-dimension embedding vector; null before embedding has been generated. */
  embedding: number[] | null;
  /** Quality score normalized to [0.0, 1.0]. */
  qualityScore: number;
  difficulty: Difficulty | null;
  /** Estimated read time in whole minutes, minimum 1. */
  readTimeMinutes: number;
  topics: ArticleTopicAssociation[];
  /** ISO-8601 timestamp. */
  publishedAt: string;
  /** ISO-8601 timestamp. */
  ingestedAt: string;
}

/** Structured output produced by the Summarizer (Requirements 7.1, 7.2). */
export interface SummarizerOutput {
  /** A summary of 2-3 sentences. */
  summary: string;
  /** Between 1 and 4 tags drawn from the topic taxonomy (slugs). */
  tags: string[];
  difficulty: Difficulty;
  /** Read time between 1 and 120 minutes. */
  readTimeMinutes: number;
}

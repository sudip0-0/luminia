// Domain types returned by the repository layer.
//
// These are the camelCase shapes the services consume, mapped from the
// snake_case PostgreSQL columns defined in `packages/api/migrations`. Where a
// shared type already exists in `@lumina/shared` (Article, Source, Depth, …) it
// is reused rather than redefined; the types here cover the rows that are
// specific to persistence (users, tokens, saves, collections, crawl state, …).

import type {
  Depth,
  Difficulty,
  FeedEventType,
  Source,
} from '@lumina/shared';

/** Provenance of a user's topic association. */
export type UserTopicSource = 'onboarding' | 'inferred';

/** Saved-article read state. */
export type ReadState = 'read' | 'unread';

/** Supported OAuth providers. */
export type OAuthProvider = 'google' | 'apple';

/** A Lumina account row (the `user` table). */
export interface UserRecord {
  id: string;
  email: string;
  /** Null for OAuth-only accounts. */
  passwordHash: string | null;
  displayName: string;
  avatarUrl: string | null;
  depthPreference: Depth;
  dailyGoalMinutes: number;
  pushEnabled: boolean;
  /** Null => the user has not completed onboarding. */
  onboardingCompletedAt: string | null;
  createdAt: string;
}

/** Fields accepted when creating a user. */
export interface CreateUserInput {
  email: string;
  passwordHash?: string | null;
  displayName: string;
  avatarUrl?: string | null;
  depthPreference?: Depth;
  dailyGoalMinutes?: number;
  pushEnabled?: boolean;
}

/** Mutable profile fields (Requirement 26.2); omitted fields are left as-is. */
export interface UpdateUserProfileInput {
  displayName?: string;
  avatarUrl?: string | null;
  depthPreference?: Depth;
  dailyGoalMinutes?: number;
  pushEnabled?: boolean;
  onboardingCompletedAt?: string | null;
}

/** A federated identity linked to a user (the `oauth_identity` table). */
export interface OAuthIdentityRecord {
  id: string;
  userId: string;
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  createdAt: string;
}

/** A hashed, expiring refresh token (the `refresh_token` table). */
export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/** A taxonomy node (the `topic` table). */
export interface TopicRecord {
  id: string;
  slug: string;
  label: string;
  parentId: string | null;
  color: string;
  iconName: string;
  /** 1536-dim centroid used by serendipity selection; null when unset. */
  centroid: number[] | null;
}

/** A user's weighted, possibly muted association with a topic (`user_topic`). */
export interface UserTopicRecord {
  userId: string;
  topicId: string;
  weight: number;
  source: UserTopicSource;
  muted: boolean;
  createdAt: string;
}

/** Fields used to upsert a user-topic association. */
export interface UpsertUserTopicInput {
  topicId: string;
  weight: number;
  source: UserTopicSource;
  muted?: boolean;
}

/** A per-user source enabled/disabled toggle (the `user_source` table). */
export interface UserSourceRecord {
  userId: string;
  source: Source;
  enabled: boolean;
}

/**
 * A complete article row mapped from the `article` table. Mirrors the shared
 * {@link import('@lumina/shared').Article} but adds persistence-only columns
 * (urlHash, summarizationStatus). `topics` is populated by joins where loaded.
 */
export interface ArticleRecord {
  id: string;
  url: string;
  urlHash: string;
  source: Source;
  title: string;
  summary: string | null;
  fullText: string | null;
  embedding: number[] | null;
  qualityScore: number;
  difficulty: Difficulty | null;
  readTimeMinutes: number;
  summarizationStatus: 'pending' | 'summarized' | 'unsummarized';
  publishedAt: string;
  ingestedAt: string;
}

/** Fields accepted when inserting a complete article. */
export interface InsertArticleInput {
  url: string;
  urlHash: string;
  source: Source;
  title: string;
  summary?: string | null;
  fullText?: string | null;
  embedding?: number[] | null;
  qualityScore: number;
  difficulty?: Difficulty | null;
  readTimeMinutes: number;
  summarizationStatus?: 'pending' | 'summarized' | 'unsummarized';
  publishedAt: string;
}

/** Filters for listing candidate articles for feed assembly. */
export interface ListArticleCandidatesFilter {
  /** Restrict to a single source. */
  source?: Source;
  /** Restrict to articles associated with this topic id. */
  topicId?: string;
  /** Exclude these article ids (e.g. already-returned or skipped). */
  excludeArticleIds?: readonly string[];
  /** Only articles published at/after this ISO timestamp. */
  publishedAfter?: string;
  /** Maximum number of rows to return. */
  limit?: number;
}

/** A confidence-weighted article/topic association (`article_topic`). */
export interface ArticleTopicRecord {
  articleId: string;
  topicId: string;
  confidence: number;
}

/** A user's interest embedding (the `user_embedding` table). */
export interface UserEmbeddingRecord {
  userId: string;
  embedding: number[];
  updatedAt: string;
}

/** A persisted behaviour signal (the `feed_event` table). */
export interface FeedEventRecord {
  id: string;
  clientEventId: string;
  userId: string;
  articleId: string | null;
  topicId: string | null;
  type: FeedEventType;
  payload: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

/** A single event to insert in a batch (Requirements 13.1, 13.4). */
export interface InsertFeedEventInput {
  clientEventId: string;
  articleId?: string | null;
  topicId?: string | null;
  type: FeedEventType;
  payload?: Record<string, unknown>;
  occurredAt: string;
}

/** Window bounds for querying events (inclusive lower, exclusive upper). */
export interface FeedEventWindow {
  from: string;
  to: string;
  types?: readonly FeedEventType[];
}

/** A saved-article row (the `saved_article` table). */
export interface SavedArticleRecord {
  userId: string;
  articleId: string;
  readState: ReadState;
  savedAt: string;
}

/** Filters/pagination for the saved-articles list (Requirement 21.4). */
export interface ListSavedArticlesFilter {
  state?: ReadState;
  source?: Source;
  /** Saved-at ISO timestamp to page after (exclusive), most-recent-first. */
  cursorSavedAt?: string;
  /** Tie-break article id paired with the cursor timestamp. */
  cursorArticleId?: string;
  /** Page size; the Library_Service caps this at 50 (Requirement 21.4). */
  limit?: number;
}

/** A user-owned collection (the `collection` table). */
export interface CollectionRecord {
  id: string;
  userId: string;
  name: string;
  color: string;
  icon: string;
  createdAt: string;
}

/** Fields used to create a collection. */
export interface CreateCollectionInput {
  userId: string;
  name: string;
  color: string;
  icon: string;
}

/** Mutable collection fields (Requirement 22.3); omitted fields stay as-is. */
export interface UpdateCollectionInput {
  name?: string;
  color?: string;
  icon?: string;
}

/** Membership of an article in a collection (the `collection_article` table). */
export interface CollectionArticleRecord {
  collectionId: string;
  articleId: string;
  addedAt: string;
}

/** An emerging-topic detection for a user (the `emerging_topic` table). */
export interface EmergingTopicRecord {
  userId: string;
  topicId: string;
  detectedAt: string;
}

/** Last-successful-crawl bookkeeping per source (the `crawl_state` table). */
export interface CrawlStateRecord {
  source: Source;
  lastSuccessfulCrawlAt: string | null;
}

/** A recorded, isolated crawl failure (the `crawl_failure` table). */
export interface CrawlFailureRecord {
  id: string;
  source: Source;
  error: string;
  occurredAt: string;
}

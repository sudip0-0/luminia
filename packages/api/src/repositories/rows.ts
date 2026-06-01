// Row -> domain mappers.
//
// Each function maps a raw snake_case PostgreSQL row (as returned by `pg`) to
// the camelCase domain record defined in ./types. They are pure and live in one
// place so column-name knowledge is centralized and consistent across
// repositories.

import type { Depth, Difficulty, FeedEventType, Source } from '@lumina/shared';
import {
  asBoolean,
  asIso,
  asIsoOrNull,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  parseVector,
} from './mappers.js';
import type {
  ArticleRecord,
  ArticleTopicRecord,
  CollectionArticleRecord,
  CollectionRecord,
  CrawlFailureRecord,
  CrawlStateRecord,
  EmergingTopicRecord,
  FeedEventRecord,
  OAuthIdentityRecord,
  OAuthProvider,
  ReadState,
  RefreshTokenRecord,
  SavedArticleRecord,
  TopicRecord,
  UserEmbeddingRecord,
  UserRecord,
  UserSourceRecord,
  UserTopicRecord,
  UserTopicSource,
} from './types.js';
import type { QueryRow } from './queryable.js';

export function mapUser(row: QueryRow): UserRecord {
  return {
    id: asString(row.id),
    email: asString(row.email),
    passwordHash: asStringOrNull(row.password_hash),
    displayName: asString(row.display_name),
    avatarUrl: asStringOrNull(row.avatar_url),
    depthPreference: asString(row.depth_preference) as Depth,
    dailyGoalMinutes: asNumber(row.daily_goal_minutes),
    pushEnabled: asBoolean(row.push_enabled),
    onboardingCompletedAt: asIsoOrNull(row.onboarding_completed_at),
    createdAt: asIso(row.created_at),
  };
}

export function mapOAuthIdentity(row: QueryRow): OAuthIdentityRecord {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    provider: asString(row.provider) as OAuthProvider,
    providerUserId: asString(row.provider_user_id),
    email: asStringOrNull(row.email),
    createdAt: asIso(row.created_at),
  };
}

export function mapRefreshToken(row: QueryRow): RefreshTokenRecord {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    tokenHash: asString(row.token_hash),
    expiresAt: asIso(row.expires_at),
    revokedAt: asIsoOrNull(row.revoked_at),
    createdAt: asIso(row.created_at),
  };
}

export function mapTopic(row: QueryRow): TopicRecord {
  return {
    id: asString(row.id),
    slug: asString(row.slug),
    label: asString(row.label),
    parentId: asStringOrNull(row.parent_id),
    color: asString(row.color),
    iconName: asString(row.icon_name),
    centroid: parseVector(row.centroid),
  };
}

export function mapUserTopic(row: QueryRow): UserTopicRecord {
  return {
    userId: asString(row.user_id),
    topicId: asString(row.topic_id),
    weight: asNumber(row.weight),
    source: asString(row.source) as UserTopicSource,
    muted: asBoolean(row.muted),
    createdAt: asIso(row.created_at),
  };
}

export function mapUserSource(row: QueryRow): UserSourceRecord {
  return {
    userId: asString(row.user_id),
    source: asString(row.source) as Source,
    enabled: asBoolean(row.enabled),
  };
}

export function mapArticle(row: QueryRow): ArticleRecord {
  return {
    id: asString(row.id),
    url: asString(row.url),
    urlHash: asString(row.url_hash),
    source: asString(row.source) as Source,
    title: asString(row.title),
    summary: asStringOrNull(row.summary),
    fullText: asStringOrNull(row.full_text),
    embedding: parseVector(row.embedding),
    qualityScore: asNumber(row.quality_score),
    difficulty: row.difficulty === null || row.difficulty === undefined
      ? null
      : (asString(row.difficulty) as Difficulty),
    readTimeMinutes: asNumber(row.read_time_minutes),
    summarizationStatus: asString(
      row.summarization_status,
    ) as ArticleRecord['summarizationStatus'],
    publishedAt: asIso(row.published_at),
    ingestedAt: asIso(row.ingested_at),
  };
}

export function mapArticleTopic(row: QueryRow): ArticleTopicRecord {
  return {
    articleId: asString(row.article_id),
    topicId: asString(row.topic_id),
    confidence: asNumber(row.confidence),
  };
}

export function mapUserEmbedding(row: QueryRow): UserEmbeddingRecord {
  const embedding = parseVector(row.embedding);
  if (embedding === null) {
    throw new Error('user_embedding.embedding is unexpectedly null.');
  }
  return {
    userId: asString(row.user_id),
    embedding,
    updatedAt: asIso(row.updated_at),
  };
}

export function mapFeedEvent(row: QueryRow): FeedEventRecord {
  return {
    id: asString(row.id),
    clientEventId: asString(row.client_event_id),
    userId: asString(row.user_id),
    articleId: asStringOrNull(row.article_id),
    topicId: asStringOrNull(row.topic_id),
    type: asString(row.type) as FeedEventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    occurredAt: asIso(row.occurred_at),
    createdAt: asIso(row.created_at),
  };
}

export function mapSavedArticle(row: QueryRow): SavedArticleRecord {
  return {
    userId: asString(row.user_id),
    articleId: asString(row.article_id),
    readState: asString(row.read_state) as ReadState,
    savedAt: asIso(row.saved_at),
  };
}

export function mapCollection(row: QueryRow): CollectionRecord {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    name: asString(row.name),
    color: asString(row.color),
    icon: asString(row.icon),
    createdAt: asIso(row.created_at),
  };
}

export function mapCollectionArticle(row: QueryRow): CollectionArticleRecord {
  return {
    collectionId: asString(row.collection_id),
    articleId: asString(row.article_id),
    addedAt: asIso(row.added_at),
  };
}

export function mapEmergingTopic(row: QueryRow): EmergingTopicRecord {
  return {
    userId: asString(row.user_id),
    topicId: asString(row.topic_id),
    detectedAt: asIso(row.detected_at),
  };
}

export function mapCrawlState(row: QueryRow): CrawlStateRecord {
  return {
    source: asString(row.source) as Source,
    lastSuccessfulCrawlAt: asIsoOrNull(row.last_successful_crawl_at),
  };
}

export function mapCrawlFailure(row: QueryRow): CrawlFailureRecord {
  return {
    id: asString(row.id),
    source: asString(row.source) as Source,
    error: asString(row.error),
    occurredAt: asIso(row.occurred_at),
  };
}

/** Coerce a `numericValue` returned by aggregate selects (count, sum). */
export function mapCount(row: QueryRow, column = 'count'): number {
  return asNumberOrNull(row[column]) ?? 0;
}

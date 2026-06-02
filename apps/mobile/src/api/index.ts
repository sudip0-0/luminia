// Shared wire types and the API barrel for the Mobile_App.

export { createApiClient } from './client';
export type { ApiClient, ApiClientDeps, TokenStore } from './client';

import type { Article, Depth } from '@lumina/shared';

/** `GET /feed` response shape (Requirement 8.1). */
export interface FeedResponseDto {
  articles: Article[];
  nextCursor: string | null;
  feedVersion: string;
}

/** A single feed card as rendered on the client; serendipity cards show a pill. */
export interface ClientFeedCard {
  article: Article;
  /** True for an injected Serendipity_Card (shows the "Something new" pill). */
  serendipity: boolean;
}

/** `GET /onboarding/topics` taxonomy entry (Requirement 3.1). */
export interface TaxonomyTopicDto {
  id: string;
  slug: string;
  label: string;
  parentId: string | null;
  color: string;
  iconName: string;
}

/** `POST /onboarding/complete` request (Requirements 3.2-3.6). */
export interface OnboardingCompleteRequest {
  topicIds: string[];
  depth: Depth;
  dailyGoalMinutes: number;
  enabledSources: string[];
}

/** Article detail with related articles (Requirement 11). */
export interface ArticleDetailDto {
  article: Article;
  related: Article[];
}

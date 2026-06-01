// Request/response envelope types shared between the API and the Mobile_App.
//
// These describe the over-the-wire contracts referenced in the design's
// "Components and Interfaces" and "Error Handling" sections. Error responses
// use the uniform envelope from ./errors; success responses are described here.

import type { Article, FeedEventType, Source } from './domain.js';

/**
 * A page of results carrying an opaque cursor for the next page. `nextCursor`
 * is null when no further pages remain.
 */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Feed response (Requirements 8.1, 8.2): 1-20 ranked articles, an opaque
 * next-page cursor, and a feed version identifier under which returned article
 * ids are tracked so cursor pages never repeat.
 */
export interface FeedResponse {
  articles: Article[];
  nextCursor: string | null;
  feedVersion: string;
}

/** A single active feed tab (Requirement 8.5). */
export interface FeedTab {
  /** `'foryou'` for the personalized tab, otherwise a topic slug. */
  key: string;
  label: string;
}

/** The active feed tabs response: `foryou` followed by 1-10 topic tabs. */
export interface FeedTabsResponse {
  tabs: FeedTab[];
}

/**
 * A single Feed_Event as submitted by the Signal_Collector in a batch
 * (Requirements 12, 13). `clientEventId` is a client-generated UUID used for
 * server-side idempotency (Requirement 13.4).
 */
export interface FeedEventInput {
  clientEventId: string;
  type: FeedEventType;
  /** Null for events without an article target (e.g. session_end). */
  articleId: string | null;
  /** Event-specific payload, e.g. `{ dwellMs }` or `{ scrollProportion }`. */
  payload?: Record<string, unknown>;
  /** Client-supplied occurrence time as an ISO-8601 timestamp. */
  occurredAt: string;
}

/** Request body for batched event ingestion (Requirement 13, <=500 events). */
export interface FeedEventBatchRequest {
  events: FeedEventInput[];
}

/** An event rejected during ingestion, identifying which event and why. */
export interface RejectedEvent {
  clientEventId: string;
  reason: string;
}

/**
 * Acknowledgement for a processed event batch (Requirement 13.3). The counts
 * reconcile against the batch size: `persisted + rejected.length + duplicates`
 * equals the number of submitted events.
 */
export interface FeedEventBatchResponse {
  persisted: number;
  rejected: RejectedEvent[];
  duplicates: number;
}

/** Filters accepted by the saved-articles listing (Requirement 21.4). */
export interface LibraryQuery {
  state?: 'read' | 'unread';
  source?: Source;
  cursor?: string;
}

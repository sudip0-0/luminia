// Durable signal-buffer types for the Mobile_App Signal_Collector.
//
// The Signal_Collector batches implicit/explicit reading events and ships them
// to the Feed_Event_Service. Unacknowledged events must survive application
// restarts (Requirement 12.10), and the local buffer is capped at 1000 events,
// evicting the oldest stored event on overflow (Requirement 12.11).
//
// The on-device store is Expo SQLite with the schema described in the design's
// "Client Local Storage" section:
//   feed_event(client_event_id PK, type, article_id, payload, occurred_at, acknowledged)
//
// To keep the capacity/eviction/idempotency logic pure and unit-testable
// without a real device or the Expo SQLite runtime, the buffer depends only on
// the {@link SignalEventStore} interface below. An in-memory implementation
// backs the unit tests (and doubles as a non-durable fallback), while the
// Expo SQLite adapter isolates the actual `expo-sqlite` calls.

import type { FeedEventType } from '@lumina/shared';

/**
 * Maximum number of Feed_Events retained in the local buffer. Recording a new
 * event that would exceed this cap evicts the oldest stored event first
 * (Requirement 12.11).
 */
export const SIGNAL_BUFFER_CAPACITY = 1000;

/**
 * A Feed_Event as persisted in the durable local buffer. Mirrors the on-device
 * `feed_event` table columns one-to-one.
 */
export interface BufferedFeedEvent {
  /** Client-generated identifier; primary key and idempotency key (Requirement 13.4). */
  clientEventId: string;
  /** One of the allowed Feed_Event types (Requirement 12, 13.2). */
  type: FeedEventType;
  /** Target article, or null for events with no article (e.g. session_end). */
  articleId: string | null;
  /** Arbitrary JSON payload (e.g. `{ dwellMs }`, `{ scrollProportion }`). */
  payload: Record<string, unknown>;
  /** Client-supplied occurrence time as an ISO-8601 (UTC) string. */
  occurredAt: string;
  /** Whether the Feed_Event_Service has acknowledged receipt of this event. */
  acknowledged: boolean;
}

/**
 * A Feed_Event to enqueue. `articleId` and `payload` are optional; a newly
 * enqueued event is always unacknowledged.
 */
export interface NewBufferedEvent {
  clientEventId: string;
  type: FeedEventType;
  articleId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Storage abstraction over the durable Feed_Event buffer. The Expo SQLite
 * adapter and the in-memory store both implement this interface, so the
 * core buffer logic never touches a real database.
 *
 * Ordering: "oldest" means ascending `occurredAt`, with insertion order as the
 * tie-breaker (FIFO).
 */
export interface SignalEventStore {
  /**
   * Persist a new event. The caller (the durable buffer) guarantees the
   * `clientEventId` is not already present; implementations should also be
   * defensively idempotent and never create a duplicate row.
   */
  insert(event: BufferedFeedEvent): Promise<void>;
  /** Whether an event with the given `clientEventId` already exists. */
  has(clientEventId: string): Promise<boolean>;
  /** Total number of stored events (acknowledged and unacknowledged). */
  count(): Promise<number>;
  /**
   * Delete the single oldest stored event and return its `clientEventId`, or
   * null when the store is empty.
   */
  deleteOldest(): Promise<string | null>;
  /**
   * List unacknowledged events oldest-first, optionally capped at `limit`.
   * These are the events that still need to be transmitted (Requirement 12.10).
   */
  listUnacknowledged(limit?: number): Promise<BufferedFeedEvent[]>;
  /**
   * Mark the given events acknowledged. Returns the number of events whose
   * state changed from unacknowledged to acknowledged.
   */
  markAcknowledged(clientEventIds: readonly string[]): Promise<number>;
}

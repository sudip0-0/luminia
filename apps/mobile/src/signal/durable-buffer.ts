// Durable Feed_Event buffer for the Mobile_App Signal_Collector.
//
// This module holds the pure capacity/eviction/idempotency logic and depends
// only on the {@link SignalEventStore} interface, so it can be unit-tested with
// the in-memory store and run on-device against the Expo SQLite adapter without
// any code change.
//
// Behaviour (Requirements 12.10, 12.11):
//   - Persists each Feed_Event keyed by its `clientEventId`.
//   - Idempotent: re-enqueuing an existing `clientEventId` does not create a
//     second row (matches the server-side idempotency on `clientEventId`).
//   - Capacity 1000: when recording a new event would exceed the cap, the
//     oldest stored event is evicted first (FIFO by `occurredAt`, then
//     insertion order), then the new event is stored.
//   - Retains unacknowledged events (the `acknowledged` flag) so they survive
//     restarts and can be re-transmitted once connectivity returns.
//   - Supports marking events acknowledged and listing unacknowledged events.

import { SIGNAL_BUFFER_CAPACITY } from './types';
import type {
  BufferedFeedEvent,
  NewBufferedEvent,
  SignalEventStore,
} from './types';

/** Outcome of an {@link DurableSignalBuffer.enqueue} call. */
export interface EnqueueResult {
  /** True when the event was stored; false when it was a duplicate no-op. */
  stored: boolean;
  /**
   * `clientEventId` of the event evicted to make room, or null when no eviction
   * occurred (either under capacity or the enqueue was a duplicate).
   */
  evictedClientEventId: string | null;
}

export interface DurableSignalBufferOptions {
  /** Override the 1000-event cap (primarily for tests). Must be >= 1. */
  capacity?: number;
}

/**
 * The durable buffer. Construct with any {@link SignalEventStore}.
 */
export class DurableSignalBuffer {
  private readonly store: SignalEventStore;
  private readonly capacity: number;

  constructor(store: SignalEventStore, options: DurableSignalBufferOptions = {}) {
    const capacity = options.capacity ?? SIGNAL_BUFFER_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Signal buffer capacity must be a positive integer, got ${capacity}`);
    }
    this.store = store;
    this.capacity = capacity;
  }

  /** The configured capacity of this buffer. */
  get maxSize(): number {
    return this.capacity;
  }

  /**
   * Record a new Feed_Event. Idempotent on `clientEventId`: a duplicate is a
   * no-op. When storing the event would push the buffer past its capacity, the
   * oldest stored event is evicted first (Requirement 12.11).
   */
  async enqueue(event: NewBufferedEvent): Promise<EnqueueResult> {
    if (await this.store.has(event.clientEventId)) {
      return { stored: false, evictedClientEventId: null };
    }

    // Evict oldest-first until there is room for exactly one more event.
    // Using a loop (rather than a single delete) keeps the invariant even if a
    // smaller capacity was configured after the store already held more rows.
    let evicted: string | null = null;
    while ((await this.store.count()) >= this.capacity) {
      const removed = await this.store.deleteOldest();
      if (removed === null) break; // store unexpectedly empty; nothing to evict
      evicted = removed;
    }

    const record: BufferedFeedEvent = {
      clientEventId: event.clientEventId,
      type: event.type,
      articleId: event.articleId ?? null,
      payload: event.payload ?? {},
      occurredAt: event.occurredAt,
      acknowledged: false,
    };
    await this.store.insert(record);

    return { stored: true, evictedClientEventId: evicted };
  }

  /** Current number of stored events (acknowledged and unacknowledged). */
  size(): Promise<number> {
    return this.store.count();
  }

  /** Whether an event with the given id is currently buffered. */
  contains(clientEventId: string): Promise<boolean> {
    return this.store.has(clientEventId);
  }

  /**
   * List unacknowledged events oldest-first (optionally capped). These are the
   * events still awaiting transmission/acknowledgement (Requirement 12.10).
   */
  listUnacknowledged(limit?: number): Promise<BufferedFeedEvent[]> {
    return this.store.listUnacknowledged(limit);
  }

  /**
   * Mark events acknowledged once the Feed_Event_Service confirms receipt.
   * Returns the number of events newly transitioned to acknowledged.
   */
  acknowledge(clientEventIds: readonly string[]): Promise<number> {
    if (clientEventIds.length === 0) return Promise.resolve(0);
    return this.store.markAcknowledged(clientEventIds);
  }
}

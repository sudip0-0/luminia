// In-memory {@link SignalEventStore} implementation.
//
// Used by the durable-buffer unit tests (so the capacity/eviction/idempotency
// logic can be exercised without a device or Expo SQLite) and usable as a
// non-durable fallback when SQLite is unavailable on the client.
//
// Ordering contract: events are returned oldest-first by ascending `occurredAt`
// with insertion order as a stable tie-breaker (FIFO). A monotonic sequence
// number captures insertion order so two events with identical `occurredAt`
// values still evict and list deterministically.

import type {
  BufferedFeedEvent,
  SignalEventStore,
} from './types';

interface StoredEntry {
  event: BufferedFeedEvent;
  /** Monotonic insertion sequence; lower means inserted earlier. */
  seq: number;
}

/** Compare two entries oldest-first: by `occurredAt`, then insertion order. */
function compareOldestFirst(a: StoredEntry, b: StoredEntry): number {
  if (a.event.occurredAt < b.event.occurredAt) return -1;
  if (a.event.occurredAt > b.event.occurredAt) return 1;
  return a.seq - b.seq;
}

/** Deep-ish clone of a buffered event so stored state is isolated from callers. */
function cloneEvent(event: BufferedFeedEvent): BufferedFeedEvent {
  return { ...event, payload: { ...event.payload } };
}

export class InMemorySignalEventStore implements SignalEventStore {
  private readonly entries = new Map<string, StoredEntry>();
  private nextSeq = 0;

  insert(event: BufferedFeedEvent): Promise<void> {
    if (!this.entries.has(event.clientEventId)) {
      this.entries.set(event.clientEventId, {
        event: cloneEvent(event),
        seq: this.nextSeq++,
      });
    }
    return Promise.resolve();
  }

  has(clientEventId: string): Promise<boolean> {
    return Promise.resolve(this.entries.has(clientEventId));
  }

  count(): Promise<number> {
    return Promise.resolve(this.entries.size);
  }

  deleteOldest(): Promise<string | null> {
    let oldest: StoredEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!oldest || compareOldestFirst(entry, oldest) < 0) {
        oldest = entry;
      }
    }
    if (!oldest) return Promise.resolve(null);
    this.entries.delete(oldest.event.clientEventId);
    return Promise.resolve(oldest.event.clientEventId);
  }

  listUnacknowledged(limit?: number): Promise<BufferedFeedEvent[]> {
    const unacked = [...this.entries.values()]
      .filter((entry) => !entry.event.acknowledged)
      .sort(compareOldestFirst)
      .map((entry) => cloneEvent(entry.event));
    const result =
      limit === undefined ? unacked : unacked.slice(0, Math.max(0, limit));
    return Promise.resolve(result);
  }

  markAcknowledged(clientEventIds: readonly string[]): Promise<number> {
    let changed = 0;
    for (const id of clientEventIds) {
      const entry = this.entries.get(id);
      if (entry && !entry.event.acknowledged) {
        entry.event.acknowledged = true;
        changed++;
      }
    }
    return Promise.resolve(changed);
  }
}

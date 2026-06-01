// Feature: lumina, Property 25: The local buffer enforces capacity by evicting oldest-first
//
// Property-based coverage for the durable Signal_Collector buffer's capacity
// and eviction logic (Requirement 12.11).
//
// Property 25 (design.md): *For any* sequence of enqueued events, the buffer
// never holds more than `capacity` events; when an insertion would exceed
// capacity, the oldest stored event is evicted first, so the retained set is
// exactly the most-recent `capacity` events in the buffer's ordering.
//
// The buffer's ordering of "oldest" is ascending `occurredAt` (compared as the
// ISO-8601 string the store stores), with insertion order as the FIFO
// tie-breaker. Two complementary properties are exercised below:
//
//   - canonical: with strictly increasing `occurredAt` (so arrival order ==
//     timestamp order), the retained set is exactly the most-recent `capacity`
//     events in arrival order and the evicted ids are exactly the oldest ones.
//   - general: with arbitrary `occurredAt` (including duplicate timestamps that
//     exercise the FIFO tie-breaker), the buffer's contents and per-step
//     evictions match an independent oldest-first reference model.
//
// Both run a minimum of 100 generated iterations. A small capacity (1..20) is
// used to keep overflow frequent and runs tractable. Implementation files are
// not modified; this test only observes the public buffer/store API.
//
// Validates: Requirements 12.11

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DurableSignalBuffer } from './durable-buffer.js';
import { InMemorySignalEventStore } from './in-memory-store.js';
import type { NewBufferedEvent } from './types.js';
import { FEED_EVENT_TYPES } from '@lumina/shared';

const RUNS = { numRuns: 200 } as const;

// Base instant for all generated timestamps. Offsets stay small so every
// `occurredAt` is a 4-digit-year ISO string, where lexicographic order (used by
// the store) matches chronological order.
const BASE_MS = Date.UTC(2024, 0, 1);

function isoAt(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** Spec for a single generated event, before ids/timestamps are assigned. */
interface EventSpec {
  type: (typeof FEED_EVENT_TYPES)[number];
  /** Relative tick used to build `occurredAt` (meaning differs per property). */
  tick: number;
}

const eventSpec: fc.Arbitrary<EventSpec> = fc.record({
  type: fc.constantFrom(...FEED_EVENT_TYPES),
  tick: fc.integer({ min: 0, max: 1000 }),
});

// --- Independent oldest-first reference model ------------------------------
// Mirrors InMemorySignalEventStore semantics: events ordered by ascending
// `occurredAt` (string compare), then by ascending insertion sequence.

interface ModelEntry {
  clientEventId: string;
  occurredAt: string;
  seq: number;
}

function olderThan(a: ModelEntry, b: ModelEntry): boolean {
  if (a.occurredAt < b.occurredAt) return true;
  if (a.occurredAt > b.occurredAt) return false;
  return a.seq < b.seq;
}

/** A reference buffer that evicts oldest-first to enforce `capacity`. */
class ReferenceBuffer {
  private readonly entries: ModelEntry[] = [];
  private nextSeq = 0;

  constructor(private readonly capacity: number) {}

  /** Returns the id evicted to make room, or null if none was evicted. */
  enqueue(event: NewBufferedEvent): string | null {
    if (this.entries.some((e) => e.clientEventId === event.clientEventId)) {
      return null; // idempotent no-op on duplicate id
    }
    let evicted: string | null = null;
    while (this.entries.length >= this.capacity) {
      let oldestIdx = 0;
      for (let i = 1; i < this.entries.length; i++) {
        if (olderThan(this.entries[i]!, this.entries[oldestIdx]!)) oldestIdx = i;
      }
      evicted = this.entries.splice(oldestIdx, 1)[0]!.clientEventId;
    }
    this.entries.push({
      clientEventId: event.clientEventId,
      occurredAt: event.occurredAt,
      seq: this.nextSeq++,
    });
    return evicted;
  }

  /** Retained ids, oldest-first by (occurredAt, seq). */
  orderedIds(): string[] {
    return [...this.entries]
      .sort((a, b) => (olderThan(a, b) ? -1 : olderThan(b, a) ? 1 : 0))
      .map((e) => e.clientEventId);
  }

  size(): number {
    return this.entries.length;
  }
}

describe('Property 25 - buffer enforces capacity by evicting oldest-first (Req 12.11)', () => {
  it('canonical: with increasing occurredAt, retains exactly the most-recent capacity events in arrival order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.array(eventSpec, { maxLength: 80 }),
        async (capacity, specs) => {
          const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity });

          // Build strictly-increasing timestamps so arrival order == timestamp
          // order; the oldest stored event is always the earliest inserted.
          let cursor = 0;
          const events: NewBufferedEvent[] = specs.map((spec, i) => {
            cursor += spec.tick + 1; // +1 keeps it strictly increasing
            return {
              clientEventId: `ce-${i}`,
              type: spec.type,
              articleId: `art-${i}`,
              occurredAt: isoAt(cursor),
            };
          });

          const evicted: string[] = [];
          for (let i = 0; i < events.length; i++) {
            const result = await buffer.enqueue(events[i]!);
            // Capacity invariant holds after every single enqueue.
            const sizeNow = await buffer.size();
            expect(sizeNow).toBeLessThanOrEqual(capacity);
            // No eviction until the buffer is full.
            if (i < capacity) {
              expect(result.evictedClientEventId).toBeNull();
            }
            if (result.evictedClientEventId !== null) {
              evicted.push(result.evictedClientEventId);
            }
          }

          const n = events.length;
          const survivors = Math.min(n, capacity);
          const firstKeptIndex = n - survivors;

          // Retained set: exactly the most-recent `capacity` events, oldest-first.
          const expectedRetained = events
            .slice(firstKeptIndex)
            .map((e) => e.clientEventId);
          const retained = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
          expect(retained).toEqual(expectedRetained);
          expect(await buffer.size()).toBe(survivors);

          // Evicted ids: exactly the oldest (earliest-arriving) events, in order.
          const expectedEvicted = events
            .slice(0, firstKeptIndex)
            .map((e) => e.clientEventId);
          expect(evicted).toEqual(expectedEvicted);
        }
      ),
      RUNS
    );
  });

  it('general: with arbitrary occurredAt, contents and per-step evictions match an oldest-first model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.array(eventSpec, { maxLength: 80 }),
        async (capacity, specs) => {
          const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity });
          const model = new ReferenceBuffer(capacity);

          const events: NewBufferedEvent[] = specs.map((spec, i) => ({
            clientEventId: `ce-${i}`,
            type: spec.type,
            articleId: `art-${i}`,
            // Arbitrary timestamps (with frequent ties) exercise the FIFO
            // tie-breaker on equal occurredAt.
            occurredAt: isoAt(spec.tick * 1000),
          }));

          for (const event of events) {
            const bufferEvicted = (await buffer.enqueue(event)).evictedClientEventId;
            const modelEvicted = model.enqueue(event);

            // Each eviction removes the same (oldest) event the model removes.
            expect(bufferEvicted).toBe(modelEvicted);

            // Capacity invariant after every enqueue.
            expect(await buffer.size()).toBeLessThanOrEqual(capacity);
            expect(await buffer.size()).toBe(model.size());

            // The retained set (and oldest-first ordering) matches the model.
            const retained = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
            expect(retained).toEqual(model.orderedIds());
          }
        }
      ),
      RUNS
    );
  });
});

import { describe, it, expect } from 'vitest';
import { DurableSignalBuffer } from './durable-buffer.js';
import { InMemorySignalEventStore } from './in-memory-store.js';
import { SIGNAL_BUFFER_CAPACITY } from './types.js';
import type { NewBufferedEvent } from './types.js';

// Unit tests for the durable Signal_Collector buffer (Requirements 12.10, 12.11).
// These exercise the pure capacity/eviction/idempotency/retention logic via the
// in-memory store, with no device or Expo SQLite runtime involved.
// Property-based coverage of capacity/eviction lives in task 25.2.

/** Build an event whose occurredAt encodes a monotonic sequence for ordering. */
function eventAt(seq: number, overrides: Partial<NewBufferedEvent> = {}): NewBufferedEvent {
  const occurredAt = new Date(Date.UTC(2024, 0, 1) + seq * 1000).toISOString();
  return {
    clientEventId: `ce-${seq}`,
    type: 'impression',
    articleId: `art-${seq}`,
    occurredAt,
    ...overrides,
  };
}

describe('DurableSignalBuffer persistence and dedup', () => {
  it('persists an event keyed by clientEventId', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    const result = await buffer.enqueue(eventAt(1, { payload: { dwellMs: 1800 } }));

    expect(result).toEqual({ stored: true, evictedClientEventId: null });
    expect(await buffer.size()).toBe(1);
    expect(await buffer.contains('ce-1')).toBe(true);

    const [stored] = await buffer.listUnacknowledged();
    expect(stored).toMatchObject({
      clientEventId: 'ce-1',
      type: 'impression',
      articleId: 'art-1',
      payload: { dwellMs: 1800 },
      acknowledged: false,
    });
  });

  it('defaults articleId to null and payload to an empty object', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    await buffer.enqueue({
      clientEventId: 'ce-session',
      type: 'session_end',
      occurredAt: new Date().toISOString(),
    });

    const [stored] = await buffer.listUnacknowledged();
    expect(stored?.articleId).toBeNull();
    expect(stored?.payload).toEqual({});
  });

  it('is idempotent on clientEventId: a re-enqueue is a no-op', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    const first = await buffer.enqueue(eventAt(1, { payload: { v: 1 } }));
    const second = await buffer.enqueue(eventAt(1, { payload: { v: 2 } }));

    expect(first.stored).toBe(true);
    expect(second).toEqual({ stored: false, evictedClientEventId: null });
    expect(await buffer.size()).toBe(1);

    // The original record is retained unchanged (no overwrite by the duplicate).
    const [stored] = await buffer.listUnacknowledged();
    expect(stored?.payload).toEqual({ v: 1 });
  });
});

describe('DurableSignalBuffer capacity and oldest-first eviction', () => {
  it('does not evict while under capacity', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 3 });
    for (let i = 1; i <= 3; i++) {
      const r = await buffer.enqueue(eventAt(i));
      expect(r.evictedClientEventId).toBeNull();
    }
    expect(await buffer.size()).toBe(3);
  });

  it('evicts the oldest event when an insertion would exceed capacity', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 3 });
    await buffer.enqueue(eventAt(1));
    await buffer.enqueue(eventAt(2));
    await buffer.enqueue(eventAt(3));

    const overflow = await buffer.enqueue(eventAt(4));
    expect(overflow.stored).toBe(true);
    expect(overflow.evictedClientEventId).toBe('ce-1'); // oldest by occurredAt

    expect(await buffer.size()).toBe(3);
    expect(await buffer.contains('ce-1')).toBe(false);
    const ids = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(ids).toEqual(['ce-2', 'ce-3', 'ce-4']);
  });

  it('evicts strictly oldest-first across repeated overflow (FIFO)', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 2 });
    for (let i = 1; i <= 5; i++) {
      await buffer.enqueue(eventAt(i));
    }
    // Only the two most recent survive; the first three were evicted oldest-first.
    const ids = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(ids).toEqual(['ce-4', 'ce-5']);
    expect(await buffer.size()).toBe(2);
  });

  it('uses insertion order as the FIFO tie-breaker for equal occurredAt', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 2 });
    const sameTime = new Date('2024-01-01T00:00:00.000Z').toISOString();
    await buffer.enqueue({ clientEventId: 'a', type: 'impression', occurredAt: sameTime });
    await buffer.enqueue({ clientEventId: 'b', type: 'impression', occurredAt: sameTime });
    const evicted = await buffer.enqueue({ clientEventId: 'c', type: 'impression', occurredAt: sameTime });

    // 'a' was inserted first, so it is evicted first despite identical timestamps.
    expect(evicted.evictedClientEventId).toBe('a');
    const ids = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(ids).toEqual(['b', 'c']);
  });

  it('enforces eviction exactly at the 1000-event boundary', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    expect(buffer.maxSize).toBe(SIGNAL_BUFFER_CAPACITY);

    // Fill to exactly capacity (1000) — no eviction yet.
    for (let i = 0; i < SIGNAL_BUFFER_CAPACITY; i++) {
      const r = await buffer.enqueue(eventAt(i));
      expect(r.evictedClientEventId).toBeNull();
    }
    expect(await buffer.size()).toBe(SIGNAL_BUFFER_CAPACITY);

    // The 1001st insertion evicts the oldest (ce-0) and keeps size at 1000.
    const overflow = await buffer.enqueue(eventAt(SIGNAL_BUFFER_CAPACITY));
    expect(overflow.stored).toBe(true);
    expect(overflow.evictedClientEventId).toBe('ce-0');
    expect(await buffer.size()).toBe(SIGNAL_BUFFER_CAPACITY);
    expect(await buffer.contains('ce-0')).toBe(false);
    expect(await buffer.contains(`ce-${SIGNAL_BUFFER_CAPACITY}`)).toBe(true);
  });

  it('does not evict when the overflowing event is a duplicate', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 3 });
    await buffer.enqueue(eventAt(1));
    await buffer.enqueue(eventAt(2));
    await buffer.enqueue(eventAt(3));

    const dup = await buffer.enqueue(eventAt(1)); // already present
    expect(dup).toEqual({ stored: false, evictedClientEventId: null });
    expect(await buffer.size()).toBe(3);
    expect(await buffer.contains('ce-1')).toBe(true);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    const store = new InMemorySignalEventStore();
    expect(() => new DurableSignalBuffer(store, { capacity: 0 })).toThrow();
    expect(() => new DurableSignalBuffer(store, { capacity: -5 })).toThrow();
    expect(() => new DurableSignalBuffer(store, { capacity: 2.5 })).toThrow();
  });
});

describe('DurableSignalBuffer acknowledgement and retention', () => {
  it('retains unacknowledged events and lists them oldest-first', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    await buffer.enqueue(eventAt(3));
    await buffer.enqueue(eventAt(1));
    await buffer.enqueue(eventAt(2));

    const ids = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(ids).toEqual(['ce-1', 'ce-2', 'ce-3']);
  });

  it('marks events acknowledged and excludes them from the unacknowledged list', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    await buffer.enqueue(eventAt(1));
    await buffer.enqueue(eventAt(2));
    await buffer.enqueue(eventAt(3));

    const changed = await buffer.acknowledge(['ce-1', 'ce-3']);
    expect(changed).toBe(2);

    // Acknowledged events are retained in storage (still counted) ...
    expect(await buffer.size()).toBe(3);
    // ... but no longer appear as awaiting transmission.
    const pending = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(pending).toEqual(['ce-2']);
  });

  it('acknowledging is idempotent and only counts newly-changed events', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    await buffer.enqueue(eventAt(1));

    expect(await buffer.acknowledge(['ce-1'])).toBe(1);
    expect(await buffer.acknowledge(['ce-1'])).toBe(0); // already acknowledged
    expect(await buffer.acknowledge(['missing'])).toBe(0); // unknown id
    expect(await buffer.acknowledge([])).toBe(0); // empty input is a no-op
  });

  it('respects the limit when listing unacknowledged events', async () => {
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore());
    for (let i = 1; i <= 5; i++) await buffer.enqueue(eventAt(i));

    const firstTwo = (await buffer.listUnacknowledged(2)).map((e) => e.clientEventId);
    expect(firstTwo).toEqual(['ce-1', 'ce-2']);
  });

  it('evicts oldest regardless of acknowledged state, preserving the cap', async () => {
    // Eviction is by age/FIFO, not by acknowledgement: a buffer full of
    // acknowledged-but-retained events still evicts oldest-first on overflow.
    const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), { capacity: 2 });
    await buffer.enqueue(eventAt(1));
    await buffer.enqueue(eventAt(2));
    await buffer.acknowledge(['ce-1', 'ce-2']);

    const overflow = await buffer.enqueue(eventAt(3));
    expect(overflow.evictedClientEventId).toBe('ce-1');
    expect(await buffer.size()).toBe(2);
  });
});

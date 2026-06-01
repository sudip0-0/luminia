// Feature: lumina, Property 24: Transmission batches never exceed 200 events
//
// Property-based coverage for the Signal_Collector's batched transmission
// (Requirement 12.8): when accumulated Feed_Events are flushed at a transmission
// tick, they are partitioned into one or more batches each containing at most
// 200 Feed_Events, and the union (in order) of those batches equals the set
// flushed — no event is dropped or duplicated.
//
// Property 24 (design.md): *For any* accumulated set of buffered events flushed
// at a transmission tick, the events are partitioned into batches each
// containing at most 200 Feed_Events, and the union of batches equals the set
// flushed.
//
// Two complementary views of the same property are exercised, both at a minimum
// of 100 generated iterations:
//
//   1. Pure splitter: `chunkForTransmission(events, 200)` over a generated array
//      of buffered events — every batch has size <= MAX_TRANSMISSION_BATCH, the
//      concatenation of batches equals the input in order, and every batch
//      except possibly the last is exactly the maximum size.
//   2. End-to-end flush: `flushOnce` against a DurableSignalBuffer seeded with a
//      generated number of events, using a recording transmitter that always
//      acks and a never-timeout wrapper — every batch handed to the transmitter
//      has size <= 200 and their concatenation equals the seeded events in order.
//
// Event counts span 0 .. well over 200 (up to ~600) so multi-batch flushes and
// exact-boundary cases are frequently generated. Implementation files are not
// modified; this test only observes the public transmit/buffer API.
//
// Validates: Requirements 12.8

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MAX_TRANSMISSION_BATCH,
  chunkForTransmission,
  flushOnce,
  type Transmitter,
  type TransmitterAck,
  type WithTimeout,
} from './transmit.js';
import { DurableSignalBuffer } from './durable-buffer.js';
import { InMemorySignalEventStore } from './in-memory-store.js';
import type { BufferedFeedEvent, NewBufferedEvent } from './types.js';
import { FEED_EVENT_TYPES } from '@lumina/shared';

const RUNS = { numRuns: 200 } as const;

// Base instant for generated timestamps; small offsets keep every `occurredAt`
// a valid 4-digit-year ISO-8601 string.
const BASE_MS = Date.UTC(2024, 0, 1);

function isoAt(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** A generated Feed_Event type, used to add realistic variety to the events. */
const feedEventType = fc.constantFrom(...FEED_EVENT_TYPES);

/**
 * Build `count` buffered events with unique `clientEventId`s and strictly
 * increasing `occurredAt`. `types[i]` (when present) sets the i-th event type;
 * otherwise a default is used. Returned events are fully formed
 * {@link BufferedFeedEvent}s suitable for `chunkForTransmission`.
 */
function buildBufferedEvents(
  count: number,
  types: readonly (typeof FEED_EVENT_TYPES)[number][] = [],
): BufferedFeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    clientEventId: `ce-${i}`,
    type: types[i] ?? 'impression',
    articleId: `art-${i}`,
    payload: {},
    occurredAt: isoAt(i * 1000),
    acknowledged: false,
  }));
}

/** Build `count` enqueue-able events with unique ids and increasing timestamps. */
function buildNewEvents(
  count: number,
  types: readonly (typeof FEED_EVENT_TYPES)[number][] = [],
): NewBufferedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    clientEventId: `ce-${i}`,
    type: types[i] ?? 'impression',
    articleId: `art-${i}`,
    occurredAt: isoAt(i * 1000),
  }));
}

/** A transmitter that always acknowledges, recording each batch it received. */
function recordingAlwaysAck(): Transmitter & { batches: BufferedFeedEvent[][] } {
  const batches: BufferedFeedEvent[][] = [];
  return {
    batches,
    send(batch): Promise<TransmitterAck> {
      batches.push([...batch]);
      return Promise.resolve({ ok: true });
    },
  };
}

/** A withTimeout that always lets the underlying promise settle (no timeout). */
const neverTimeout: WithTimeout = async (promise) => ({
  timedOut: false,
  value: await promise,
});

describe('Property 24 - transmission batches never exceed 200 events (Req 12.8)', () => {
  it('chunkForTransmission: every batch <= 200, batches concatenate to the input in order, and all but the last are exactly 200', () => {
    expect(MAX_TRANSMISSION_BATCH).toBe(200);

    fc.assert(
      fc.property(
        // Counts span 0 .. ~600 so 0-, 1-, 2-, and 3-batch flushes all occur,
        // including exact multiples of 200.
        fc.nat({ max: 600 }),
        fc.array(feedEventType, { maxLength: 600 }),
        (count, types) => {
          const events = buildBufferedEvents(count, types);
          const batches = chunkForTransmission(events, MAX_TRANSMISSION_BATCH);

          // (a) No batch exceeds the maximum of 200 events.
          for (const batch of batches) {
            expect(batch.length).toBeLessThanOrEqual(MAX_TRANSMISSION_BATCH);
          }

          // (b) Union of batches, in order, equals the input (no drop/dupe).
          const flattenedIds = batches.flatMap((b) => b.map((e) => e.clientEventId));
          expect(flattenedIds).toEqual(events.map((e) => e.clientEventId));

          // (c) Every batch except possibly the last is exactly the max size,
          //     and a non-empty input always yields a non-empty last batch.
          if (batches.length > 0) {
            for (let i = 0; i < batches.length - 1; i++) {
              expect(batches[i]!.length).toBe(MAX_TRANSMISSION_BATCH);
            }
            const last = batches[batches.length - 1]!.length;
            expect(last).toBeGreaterThan(0);
            expect(last).toBeLessThanOrEqual(MAX_TRANSMISSION_BATCH);
          } else {
            // No batches only when there were no events to flush.
            expect(events).toHaveLength(0);
          }

          // (d) Batch count is the ceiling of count / 200.
          expect(batches.length).toBe(Math.ceil(events.length / MAX_TRANSMISSION_BATCH));
        },
      ),
      RUNS,
    );
  });

  it('flushOnce: every batch handed to the transmitter has size <= 200 and they concatenate to the seeded events in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 600 }),
        fc.array(feedEventType, { maxLength: 600 }),
        async (count, types) => {
          // Capacity >= count so seeding never triggers eviction; the buffer
          // holds exactly the generated events awaiting transmission.
          const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), {
            capacity: Math.max(count, 1),
          });
          const newEvents = buildNewEvents(count, types);
          for (const event of newEvents) {
            await buffer.enqueue(event);
          }

          const transmitter = recordingAlwaysAck();
          const result = await flushOnce({
            buffer,
            transmitter,
            withTimeout: neverTimeout,
          });

          // Every batch the transmitter received is within the 200 cap.
          for (const batch of transmitter.batches) {
            expect(batch.length).toBeLessThanOrEqual(MAX_TRANSMISSION_BATCH);
          }

          // The transmitted batches, concatenated in order, are exactly the
          // seeded events (no event dropped or duplicated on the wire).
          const transmittedIds = transmitter.batches.flatMap((b) =>
            b.map((e) => e.clientEventId),
          );
          expect(transmittedIds).toEqual(newEvents.map((e) => e.clientEventId));

          // Batch accounting matches the ceiling split, and all were acked.
          const expectedBatches = Math.ceil(count / MAX_TRANSMISSION_BATCH);
          expect(result.batchesSent).toBe(expectedBatches);
          expect(transmitter.batches).toHaveLength(expectedBatches);
          expect(result.eventsAcknowledged).toBe(count);
        },
      ),
      RUNS,
    );
  });
});

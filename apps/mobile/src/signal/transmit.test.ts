import { describe, it, expect } from 'vitest';
import {
  ACK_TIMEOUT_MS,
  FLUSH_INTERVAL_MS,
  MAX_TRANSMISSION_BATCH,
  chunkForTransmission,
  flushOnce,
  realTimerWithTimeout,
  type Transmitter,
  type TransmitterAck,
  type WithTimeout,
} from './transmit.js';
import { DurableSignalBuffer } from './durable-buffer.js';
import { InMemorySignalEventStore } from './in-memory-store.js';
import type { BufferedFeedEvent, NewBufferedEvent } from './types.js';

// Unit tests for batched transmission with retry (Requirements 12.8, 12.9).
// The transport and the ack-timeout wrapper are injected, so these tests are
// fully deterministic with no real timers or network. Property-based coverage
// of batch size lives in task 25.7.

/** A buffered event whose occurredAt encodes a monotonic ordering sequence. */
function bufferedAt(seq: number): BufferedFeedEvent {
  return {
    clientEventId: `ce-${seq}`,
    type: 'impression',
    articleId: `art-${seq}`,
    payload: {},
    occurredAt: new Date(Date.UTC(2024, 0, 1) + seq * 1000).toISOString(),
    acknowledged: false,
  };
}

/** A new (enqueue-able) event whose occurredAt encodes a monotonic sequence. */
function newAt(seq: number): NewBufferedEvent {
  return {
    clientEventId: `ce-${seq}`,
    type: 'impression',
    articleId: `art-${seq}`,
    occurredAt: new Date(Date.UTC(2024, 0, 1) + seq * 1000).toISOString(),
  };
}

/** Seed a durable buffer (in-memory store) with `count` unacknowledged events. */
async function seededBuffer(count: number): Promise<DurableSignalBuffer> {
  const buffer = new DurableSignalBuffer(new InMemorySignalEventStore(), {
    capacity: Math.max(count, 1),
  });
  for (let i = 1; i <= count; i++) {
    await buffer.enqueue(newAt(i));
  }
  return buffer;
}

/** A transmitter that always acknowledges, recording every batch it received. */
function alwaysAck(): Transmitter & { batches: BufferedFeedEvent[][] } {
  const batches: BufferedFeedEvent[][] = [];
  return {
    batches,
    send(batch): Promise<TransmitterAck> {
      batches.push([...batch]);
      return Promise.resolve({ ok: true });
    },
  };
}

/** A withTimeout that always reports a timeout without awaiting the promise. */
const alwaysTimeout: WithTimeout = (promise) => {
  promise.catch(() => undefined); // avoid unhandled rejection in tests
  return Promise.resolve({ timedOut: true });
};

/** A withTimeout that always lets the underlying promise settle (no timeout). */
const neverTimeout: WithTimeout = async (promise) => ({
  timedOut: false,
  value: await promise,
});

describe('chunkForTransmission', () => {
  it('caps each batch at the default maximum of 200 events', () => {
    const events = Array.from({ length: 450 }, (_, i) => bufferedAt(i));
    const batches = chunkForTransmission(events);

    expect(MAX_TRANSMISSION_BATCH).toBe(200);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(200);
    }
  });

  it('caps each batch at exactly 200 with no remainder when evenly divisible', () => {
    const events = Array.from({ length: 400 }, (_, i) => bufferedAt(i));
    const batches = chunkForTransmission(events);
    expect(batches.map((b) => b.length)).toEqual([200, 200]);
  });

  it('returns the events in order with none dropped or duplicated', () => {
    const events = Array.from({ length: 205 }, (_, i) => bufferedAt(i));
    const batches = chunkForTransmission(events);
    const flattenedIds = batches.flat().map((e) => e.clientEventId);
    expect(flattenedIds).toEqual(events.map((e) => e.clientEventId));
  });

  it('returns no batches for an empty input', () => {
    expect(chunkForTransmission([])).toEqual([]);
  });

  it('respects a custom maxBatchSize', () => {
    const events = Array.from({ length: 5 }, (_, i) => bufferedAt(i));
    const batches = chunkForTransmission(events, 2);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('rejects a non-positive or non-integer maxBatchSize', () => {
    expect(() => chunkForTransmission([bufferedAt(0)], 0)).toThrow();
    expect(() => chunkForTransmission([bufferedAt(0)], -1)).toThrow();
    expect(() => chunkForTransmission([bufferedAt(0)], 1.5)).toThrow();
  });
});

describe('flushOnce - successful transmission', () => {
  it('splits unacknowledged events into <=200 batches and sends them', async () => {
    const buffer = await seededBuffer(450);
    const transmitter = alwaysAck();

    const result = await flushOnce({
      buffer,
      transmitter,
      withTimeout: neverTimeout,
    });

    expect(transmitter.batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(result.batchesSent).toBe(3);
    expect(result.batchesAcknowledged).toBe(3);
    expect(result.batchesFailed).toBe(0);
  });

  it('acknowledges events of an acknowledged batch so they are not resent', async () => {
    const buffer = await seededBuffer(3);
    const transmitter = alwaysAck();

    const result = await flushOnce({
      buffer,
      transmitter,
      withTimeout: neverTimeout,
    });

    expect(result.eventsAcknowledged).toBe(3);
    expect(result.eventsRetained).toBe(0);
    // The buffer now has nothing left awaiting transmission.
    expect(await buffer.listUnacknowledged()).toEqual([]);

    // A second flush finds nothing to send (no resend of acknowledged events).
    const second = await flushOnce({
      buffer,
      transmitter,
      withTimeout: neverTimeout,
    });
    expect(second.batchesSent).toBe(0);
    expect(transmitter.batches).toHaveLength(1);
  });

  it('does nothing when there are no unacknowledged events', async () => {
    const buffer = await seededBuffer(0);
    const transmitter = alwaysAck();

    const result = await flushOnce({ buffer, transmitter });

    expect(transmitter.batches).toHaveLength(0);
    expect(result).toEqual({
      batchesSent: 0,
      batchesAcknowledged: 0,
      batchesFailed: 0,
      eventsAcknowledged: 0,
      eventsRetained: 0,
    });
  });
});

describe('flushOnce - failed/timed-out transmission retains events', () => {
  it('retains events (does not acknowledge) when the batch times out within 10s', async () => {
    const buffer = await seededBuffer(3);
    // Transport that never settles; the injected timeout fires instead.
    const transmitter: Transmitter = { send: () => new Promise<TransmitterAck>(() => {}) };

    const result = await flushOnce({
      buffer,
      transmitter,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      withTimeout: alwaysTimeout,
    });

    expect(result.batchesFailed).toBe(1);
    expect(result.eventsAcknowledged).toBe(0);
    expect(result.eventsRetained).toBe(3);
    // All three events remain awaiting transmission for a later retry.
    const pending = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(pending).toEqual(['ce-1', 'ce-2', 'ce-3']);
  });

  it('retains events when the transport reports a negative acknowledgement', async () => {
    const buffer = await seededBuffer(2);
    const transmitter: Transmitter = { send: () => Promise.resolve({ ok: false }) };

    const result = await flushOnce({ buffer, transmitter, withTimeout: neverTimeout });

    expect(result.batchesFailed).toBe(1);
    expect(result.eventsRetained).toBe(2);
    expect((await buffer.listUnacknowledged()).length).toBe(2);
  });

  it('retains events when the transport promise rejects', async () => {
    const buffer = await seededBuffer(2);
    const transmitter: Transmitter = {
      send: () => Promise.reject(new Error('network down')),
    };

    const result = await flushOnce({ buffer, transmitter, withTimeout: neverTimeout });

    expect(result.batchesFailed).toBe(1);
    expect(result.eventsRetained).toBe(2);
    expect((await buffer.listUnacknowledged()).length).toBe(2);
  });

  it('retries retained events on a subsequent flush once the transport recovers', async () => {
    const buffer = await seededBuffer(2);
    let healthy = false;
    const sent: BufferedFeedEvent[][] = [];
    const transmitter: Transmitter = {
      send(batch): Promise<TransmitterAck> {
        sent.push([...batch]);
        return Promise.resolve({ ok: healthy });
      },
    };

    // First flush fails: events retained.
    const first = await flushOnce({ buffer, transmitter, withTimeout: neverTimeout });
    expect(first.eventsRetained).toBe(2);
    expect((await buffer.listUnacknowledged()).length).toBe(2);

    // Transport recovers; the retained events are retried and acknowledged.
    healthy = true;
    const second = await flushOnce({ buffer, transmitter, withTimeout: neverTimeout });
    expect(second.eventsAcknowledged).toBe(2);
    expect(await buffer.listUnacknowledged()).toEqual([]);
    expect(sent).toHaveLength(2); // attempted on both flushes
  });
});

describe('flushOnce - mixed success and failure across batches', () => {
  it('acknowledges succeeding batches and retains failing ones', async () => {
    const buffer = await seededBuffer(5);
    // maxBatchSize 2 => batches [ce-1,ce-2], [ce-3,ce-4], [ce-5].
    // Fail only the middle batch (the one containing ce-3).
    const transmitter: Transmitter = {
      send(batch): Promise<TransmitterAck> {
        const failing = batch.some((e) => e.clientEventId === 'ce-3');
        return Promise.resolve({ ok: !failing });
      },
    };

    const result = await flushOnce({
      buffer,
      transmitter,
      maxBatchSize: 2,
      withTimeout: neverTimeout,
    });

    expect(result.batchesSent).toBe(3);
    expect(result.batchesAcknowledged).toBe(2);
    expect(result.batchesFailed).toBe(1);
    expect(result.eventsAcknowledged).toBe(3); // ce-1, ce-2, ce-5
    expect(result.eventsRetained).toBe(2); // ce-3, ce-4

    // Only the failed batch's events remain awaiting transmission.
    const pending = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(pending).toEqual(['ce-3', 'ce-4']);
  });

  it('persists an earlier batch ack even when a later batch fails', async () => {
    const buffer = await seededBuffer(4);
    // Batches are processed in order: [ce-1,ce-2] then [ce-3,ce-4].
    const sent: BufferedFeedEvent[][] = [];
    const transmitter: Transmitter = {
      send(batch): Promise<TransmitterAck> {
        sent.push([...batch]);
        return Promise.resolve({ ok: true });
      },
    };
    // Deterministically time out only the second batch by call order, proving
    // the first batch's acknowledgement is persisted before the failure.
    let call = 0;
    const timeoutSecondBatch: WithTimeout = (promise) => {
      call += 1;
      promise.catch(() => undefined);
      return call === 1
        ? neverTimeout(promise)
        : Promise.resolve({ timedOut: true });
    };

    const result = await flushOnce({
      buffer,
      transmitter,
      maxBatchSize: 2,
      withTimeout: timeoutSecondBatch,
    });

    expect(sent.map((b) => b.map((e) => e.clientEventId))).toEqual([
      ['ce-1', 'ce-2'],
      ['ce-3', 'ce-4'],
    ]);
    expect(result.eventsAcknowledged).toBe(2);
    expect(result.eventsRetained).toBe(2);
    const pending = (await buffer.listUnacknowledged()).map((e) => e.clientEventId);
    expect(pending).toEqual(['ce-3', 'ce-4']);
  });
});

describe('transmission cadence constants', () => {
  it('defines the documented flush cadence', () => {
    expect(FLUSH_INTERVAL_MS).toBe(30_000);
    expect(ACK_TIMEOUT_MS).toBe(10_000);
    expect(MAX_TRANSMISSION_BATCH).toBe(200);
  });
});

describe('realTimerWithTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    const outcome = await realTimerWithTimeout(Promise.resolve(42), 1000);
    expect(outcome).toEqual({ timedOut: false, value: 42 });
  });

  it('reports a timeout when the promise does not settle in time', async () => {
    const outcome = await realTimerWithTimeout(new Promise<number>(() => {}), 5);
    expect(outcome).toEqual({ timedOut: true });
  });
});

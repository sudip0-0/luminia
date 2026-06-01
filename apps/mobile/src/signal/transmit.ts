// Signal_Collector batched transmission with retry (Requirements 12.8, 12.9).
//
// Mirrors the design's `flush()` for the Signal_Collector:
//   flush() // every 30s; batches ≤200; retain on no-ack within 10s; retry
//
// The core logic here is PURE and injectable so it can be unit-tested without a
// real device, network, or timers:
//   - `chunkForTransmission` splits accumulated events into batches of at most
//     200 (Requirement 12.8).
//   - `flushOnce` reads unacknowledged events from the durable buffer, splits
//     them into ≤200-event batches, sends each batch through an injected
//     {@link Transmitter}, and — treating no acknowledgement within 10 s as a
//     failure (Requirement 12.9) — acknowledges the events of an acknowledged
//     batch (so they are not resent) while retaining the events of a
//     failed/timed-out batch for a later retry.
//
// The caller drives the clock and supplies the transport: the 30-second
// scheduling is a thin documented wrapper ({@link startTransmissionLoop}) over
// the unit-testable `flushOnce`. The ack-timeout is provided by an injectable
// {@link WithTimeout} wrapper, defaulting to {@link realTimerWithTimeout}, so
// tests can drive timeouts deterministically.

import type { BufferedFeedEvent } from './types.js';

/**
 * Flush cadence: transmit accumulated Feed_Events when 30 seconds have elapsed
 * since the previous transmission attempt (Requirement 12.8).
 */
export const FLUSH_INTERVAL_MS = 30_000;

/**
 * Acknowledgement deadline: a batch that is not acknowledged within 10 seconds
 * is treated as failed and retained for retry (Requirement 12.9).
 */
export const ACK_TIMEOUT_MS = 10_000;

/**
 * Maximum number of Feed_Events per transmitted batch. The accumulated events
 * are split into one or more batches, each containing at most this many events
 * (Requirement 12.8).
 */
export const MAX_TRANSMISSION_BATCH = 200;

/**
 * Acknowledgement returned by the transport for a transmitted batch. `ok: true`
 * means the Feed_Event_Service confirmed receipt of the batch; `ok: false` is a
 * negative acknowledgement and is treated as a transmission failure.
 */
export interface TransmitterAck {
  readonly ok: boolean;
}

/**
 * The injected transport that ships a batch of Feed_Events to the
 * Feed_Event_Service. The implementation is supplied by the caller (real HTTP
 * client on-device, a fake in tests). A rejected promise, a negative ack, or no
 * acknowledgement within {@link ACK_TIMEOUT_MS} are all treated as failures.
 */
export interface Transmitter {
  send(batch: readonly BufferedFeedEvent[]): Promise<TransmitterAck>;
}

/**
 * Minimal view of the durable buffer needed for transmission. The full
 * {@link import('./durable-buffer.js').DurableSignalBuffer} is structurally
 * assignable to this, so the transmission logic depends only on the two methods
 * it uses and never touches the buffer's storage.
 */
export interface TransmitBuffer {
  /** Unacknowledged events oldest-first, optionally capped at `limit`. */
  listUnacknowledged(limit?: number): Promise<BufferedFeedEvent[]>;
  /** Mark the given events acknowledged so they are not retransmitted. */
  acknowledge(clientEventIds: readonly string[]): Promise<number>;
}

/** The underlying promise settled with a value before the timeout elapsed. */
export interface TimeoutResolved<T> {
  readonly timedOut: false;
  readonly value: T;
}

/** The timeout elapsed before the underlying promise settled. */
export interface TimeoutExpired {
  readonly timedOut: true;
}

export type TimeoutOutcome<T> = TimeoutResolved<T> | TimeoutExpired;

/**
 * Races a promise against a timeout. Resolves with `{ timedOut: false, value }`
 * if the promise settles first, or `{ timedOut: true }` once `timeoutMs`
 * elapses. Injecting this lets tests simulate ack-timeouts deterministically.
 */
export type WithTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
) => Promise<TimeoutOutcome<T>>;

/**
 * Default {@link WithTimeout} built on the platform timer. Used by the
 * production scheduling wrapper; unit tests inject a deterministic substitute.
 */
export const realTimerWithTimeout: WithTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutOutcome<T>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutExpired>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const wrapped = promise.then(
    (value): TimeoutOutcome<T> => ({ timedOut: false, value }),
  );
  // If the underlying promise rejects after the timeout already won the race,
  // its rejection would otherwise surface as an unhandled rejection.
  wrapped.catch(() => undefined);
  return Promise.race([wrapped, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/** Why a batch transmission was not acknowledged. */
export type AckFailureReason = 'rejected' | 'timeout' | 'nack';

/** Outcome of transmitting a single batch and awaiting its acknowledgement. */
export type BatchAckOutcome =
  | { readonly acknowledged: true }
  | { readonly acknowledged: false; readonly reason: AckFailureReason };

/** Summary of a single flush pass. */
export interface FlushResult {
  /** Number of batches the unacknowledged events were split into and sent. */
  readonly batchesSent: number;
  /** Number of batches acknowledged within the deadline. */
  readonly batchesAcknowledged: number;
  /** Number of batches that failed (rejected, nacked, or timed out). */
  readonly batchesFailed: number;
  /** Total events acknowledged (and thus marked so they are not resent). */
  readonly eventsAcknowledged: number;
  /** Total events retained for retry because their batch was not acknowledged. */
  readonly eventsRetained: number;
}

/** Dependencies for {@link flushOnce}. The caller supplies transport and clock. */
export interface FlushDeps {
  /** The durable buffer to read unacknowledged events from and acknowledge into. */
  readonly buffer: TransmitBuffer;
  /** The transport used to ship each batch. */
  readonly transmitter: Transmitter;
  /** Max events per batch. Defaults to {@link MAX_TRANSMISSION_BATCH} (200). */
  readonly maxBatchSize?: number;
  /** Ack deadline in ms. Defaults to {@link ACK_TIMEOUT_MS} (10 000). */
  readonly ackTimeoutMs?: number;
  /** Timeout wrapper. Defaults to {@link realTimerWithTimeout}. */
  readonly withTimeout?: WithTimeout;
}

/**
 * Split `events` into batches each containing at most `maxBatchSize` events,
 * preserving order. The union (in order) of the returned batches equals the
 * input, so no event is dropped or duplicated (Requirement 12.8).
 *
 * @throws if `maxBatchSize` is not a positive integer.
 */
export function chunkForTransmission(
  events: readonly BufferedFeedEvent[],
  maxBatchSize: number = MAX_TRANSMISSION_BATCH,
): BufferedFeedEvent[][] {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new Error(
      `maxBatchSize must be a positive integer, got ${maxBatchSize}`,
    );
  }
  const batches: BufferedFeedEvent[][] = [];
  for (let i = 0; i < events.length; i += maxBatchSize) {
    batches.push(events.slice(i, i + maxBatchSize));
  }
  return batches;
}

/**
 * Transmit one batch and await its acknowledgement under the ack deadline. A
 * rejected promise, a negative ack, or no acknowledgement within `ackTimeoutMs`
 * are all reported as a non-acknowledged outcome (Requirement 12.9).
 */
async function transmitBatch(
  batch: readonly BufferedFeedEvent[],
  transmitter: Transmitter,
  ackTimeoutMs: number,
  withTimeout: WithTimeout,
): Promise<BatchAckOutcome> {
  try {
    const outcome = await withTimeout(transmitter.send(batch), ackTimeoutMs);
    if (outcome.timedOut) {
      return { acknowledged: false, reason: 'timeout' };
    }
    return outcome.value.ok
      ? { acknowledged: true }
      : { acknowledged: false, reason: 'nack' };
  } catch {
    return { acknowledged: false, reason: 'rejected' };
  }
}

/**
 * Perform a single flush pass (the unit-testable core of `flush()`):
 *   1. Read the unacknowledged events from the durable buffer.
 *   2. Split them into batches of at most `maxBatchSize` (≤200; Requirement 12.8).
 *   3. Send each batch through the transport, awaiting acknowledgement under the
 *      ack deadline.
 *   4. On acknowledgement, acknowledge that batch's events in the buffer so they
 *      are not resent; on failure/timeout, retain them (do nothing) so the next
 *      flush retries them (Requirement 12.9).
 *
 * Batches are processed sequentially so an earlier batch's acknowledgement is
 * persisted even if a later batch fails. Returns a {@link FlushResult} summary.
 */
export async function flushOnce(deps: FlushDeps): Promise<FlushResult> {
  const {
    buffer,
    transmitter,
    maxBatchSize = MAX_TRANSMISSION_BATCH,
    ackTimeoutMs = ACK_TIMEOUT_MS,
    withTimeout = realTimerWithTimeout,
  } = deps;

  const pending = await buffer.listUnacknowledged();
  const batches = chunkForTransmission(pending, maxBatchSize);

  let batchesAcknowledged = 0;
  let batchesFailed = 0;
  let eventsAcknowledged = 0;
  let eventsRetained = 0;

  for (const batch of batches) {
    const outcome = await transmitBatch(
      batch,
      transmitter,
      ackTimeoutMs,
      withTimeout,
    );
    if (outcome.acknowledged) {
      await buffer.acknowledge(batch.map((event) => event.clientEventId));
      batchesAcknowledged++;
      eventsAcknowledged += batch.length;
    } else {
      // Retain the unacknowledged events (do NOT acknowledge) for retry.
      batchesFailed++;
      eventsRetained += batch.length;
    }
  }

  return {
    batchesSent: batches.length,
    batchesAcknowledged,
    batchesFailed,
    eventsAcknowledged,
    eventsRetained,
  };
}

/** Options for {@link startTransmissionLoop}. */
export interface TransmissionLoopOptions {
  /** Flush cadence in ms. Defaults to {@link FLUSH_INTERVAL_MS} (30 000). */
  readonly intervalMs?: number;
  /** Invoked with the result of each completed flush pass (optional). */
  readonly onFlush?: (result: FlushResult) => void;
  /** Invoked if a flush pass throws unexpectedly (optional). */
  readonly onError?: (error: unknown) => void;
}

/**
 * Thin scheduling wrapper around {@link flushOnce}: invokes a flush pass every
 * `intervalMs` (default 30 s; Requirement 12.8). This is the only timer-bound
 * part of transmission and is intentionally minimal — all batching/retry logic
 * lives in the pure, injectable `flushOnce`. A reentrancy guard prevents a slow
 * flush from overlapping with the next tick. Returns a stop function that clears
 * the interval.
 */
export function startTransmissionLoop(
  deps: FlushDeps,
  options: TransmissionLoopOptions = {},
): () => void {
  const { intervalMs = FLUSH_INTERVAL_MS, onFlush, onError } = options;
  let inFlight = false;

  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    flushOnce(deps)
      .then((result) => onFlush?.(result))
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        inFlight = false;
      });
  };

  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

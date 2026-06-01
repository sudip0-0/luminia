import { describe, it, expect, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import {
  MAX_EMBEDDING_ATTEMPTS,
  embed,
  isValidEmbedding,
  validateEmbedding,
  type EmbedFailureLog,
  type EmbeddingClient,
} from './embedder.js';

/** Build a valid embedding: exactly EMBEDDING_DIMENSIONS finite numbers. */
function makeEmbedding(fill: (i: number) => number = () => 0.5): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => fill(i));
}

/**
 * A scripted embedding client: each queued step either resolves with a vector
 * or rejects with an error, in order. Records how many times it was called.
 */
function scriptedClient(
  steps: Array<{ resolve: number[] } | { reject: unknown }>
): EmbeddingClient & { calls: number } {
  let index = 0;
  const client = {
    calls: 0,
    async embed(_text: string): Promise<number[]> {
      client.calls++;
      const step = steps[index++];
      if (step === undefined) {
        throw new Error('embedding client called more times than scripted');
      }
      if ('reject' in step) {
        throw step.reject;
      }
      return step.resolve;
    },
  };
  return client;
}

describe('validateEmbedding / isValidEmbedding', () => {
  it('accepts a vector of exactly EMBEDDING_DIMENSIONS finite numbers', () => {
    expect(validateEmbedding(makeEmbedding())).toEqual({ ok: true });
    expect(isValidEmbedding(makeEmbedding())).toBe(true);
  });

  it('rejects a vector that is too short', () => {
    const result = validateEmbedding(makeEmbedding().slice(0, EMBEDDING_DIMENSIONS - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-dimension');
  });

  it('rejects a vector that is too long', () => {
    const result = validateEmbedding([...makeEmbedding(), 0.1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-dimension');
  });

  it('rejects non-array inputs', () => {
    expect(isValidEmbedding(null)).toBe(false);
    expect(isValidEmbedding(undefined)).toBe(false);
    expect(isValidEmbedding('vector')).toBe(false);
  });

  it('rejects a correctly sized vector containing a non-finite value', () => {
    const withNaN = makeEmbedding();
    withNaN[10] = Number.NaN;
    const nanResult = validateEmbedding(withNaN);
    expect(nanResult.ok).toBe(false);
    if (!nanResult.ok) expect(nanResult.reason).toBe('invalid-values');

    const withInfinity = makeEmbedding();
    withInfinity[0] = Number.POSITIVE_INFINITY;
    const infResult = validateEmbedding(withInfinity);
    expect(infResult.ok).toBe(false);
    if (!infResult.ok) expect(infResult.reason).toBe('invalid-values');
  });
});

describe('embed (bounded retries, Requirements 7.5-7.7)', () => {
  it('succeeds on the first attempt and does not log a failure', async () => {
    const vector = makeEmbedding(() => 0.25);
    const client = scriptedClient([{ resolve: vector }]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('hello world', { client, logFailure });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.embedding).toBe(vector);
      expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(result.attempts).toBe(1);
    }
    expect(client.calls).toBe(1);
    expect(logFailure).not.toHaveBeenCalled();
  });

  it('retries after a transient client error and then succeeds', async () => {
    const vector = makeEmbedding();
    const client = scriptedClient([
      { reject: new Error('503 temporarily unavailable') },
      { resolve: vector },
    ]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('text', { client, logFailure });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.embedding).toBe(vector);
      expect(result.attempts).toBe(2);
    }
    expect(client.calls).toBe(2);
    expect(logFailure).not.toHaveBeenCalled();
  });

  it('treats a wrong-dimension output as invalid and retries, then succeeds', async () => {
    const tooShort = makeEmbedding().slice(0, 100);
    const good = makeEmbedding();
    const client = scriptedClient([{ resolve: tooShort }, { resolve: good }]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('text', { client, logFailure });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.embedding).toBe(good);
      expect(result.attempts).toBe(2);
    }
    expect(client.calls).toBe(2);
    expect(logFailure).not.toHaveBeenCalled();
  });

  it('blocks storage and logs the failure after exhausting all 3 attempts', async () => {
    const client = scriptedClient([
      { reject: new Error('boom 1') },
      { reject: new Error('boom 2') },
      { reject: new Error('boom 3') },
    ]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('text', { client, logFailure });

    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.storageBlocked).toBe(true);
      expect(result.attempts).toBe(MAX_EMBEDDING_ATTEMPTS);
      expect(result.attemptErrors).toHaveLength(MAX_EMBEDDING_ATTEMPTS);
      expect(result.attemptErrors.every((e) => e.reason === 'client-error')).toBe(true);
    }
    expect(client.calls).toBe(MAX_EMBEDDING_ATTEMPTS);
    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: MAX_EMBEDDING_ATTEMPTS })
    );
  });

  it('never exceeds the maximum number of attempts on persistent invalid dimensions', async () => {
    const tooShort = makeEmbedding().slice(0, 10);
    const client = scriptedClient([
      { resolve: tooShort },
      { resolve: tooShort },
      { resolve: tooShort },
    ]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('text', { client, logFailure });

    expect(result.status).toBe('failure');
    expect(client.calls).toBe(MAX_EMBEDDING_ATTEMPTS);
    if (result.status === 'failure') {
      expect(result.attemptErrors.every((e) => e.reason === 'invalid-dimension')).toBe(true);
    }
    expect(logFailure).toHaveBeenCalledTimes(1);
  });

  it('does not throw on exhaustion and awaits an asynchronous failure logger', async () => {
    const client = scriptedClient([
      { reject: new Error('x') },
      { reject: new Error('y') },
      { reject: new Error('z') },
    ]);
    const order: string[] = [];
    const logFailure = async (): Promise<void> => {
      await Promise.resolve();
      order.push('logged');
    };

    const result = await embed('text', { client, logFailure });
    order.push('returned');

    expect(result.status).toBe('failure');
    expect(order).toEqual(['logged', 'returned']);
  });

  it('succeeds without an extra call when the final attempt is the one that works', async () => {
    const good = makeEmbedding();
    const client = scriptedClient([
      { reject: new Error('1') },
      { resolve: makeEmbedding().slice(0, 5) }, // invalid dimension
      { resolve: good },
    ]);
    const logFailure = vi.fn<(f: EmbedFailureLog) => void>();

    const result = await embed('text', { client, logFailure });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.attempts).toBe(MAX_EMBEDDING_ATTEMPTS);
      expect(result.embedding).toBe(good);
    }
    expect(client.calls).toBe(MAX_EMBEDDING_ATTEMPTS);
    expect(logFailure).not.toHaveBeenCalled();
  });
});

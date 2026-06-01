// Embedder — Ingestion_Pipeline component (Requirements 7.5, 7.6, 7.7).
//
// Generates a 1536-dimension embedding vector for an Article *before* it is
// stored. Embedding generation is the only network-bound step here, so the
// embedding API call is injected behind {@link EmbeddingClient}; the
// orchestration logic — dimension/finiteness validation, bounded retries, and
// the terminal-state decision — stays pure and is exercised without any
// network in tests.
//
// Contract (Requirements 7.5–7.7, Property 9):
//   - A valid embedding has exactly EMBEDDING_DIMENSIONS (1536) finite numbers
//     (Requirement 7.5).
//   - On a failed call or an invalid (wrong-dimension / non-finite) result the
//     Embedder retries, making at most MAX_EMBEDDING_ATTEMPTS (3) attempts in
//     total (Requirement 7.6). Storage is blocked until an attempt succeeds or
//     the attempt budget is exhausted.
//   - {@link embed} never throws on exhaustion. It returns a discriminated
//     result: a `success` carrying the validated embedding (storage may
//     proceed), or a `failure` (storage is blocked) after the budget is spent,
//     and it invokes the injected failure logger exactly once (Requirement 7.7).

import { EMBEDDING_DIMENSIONS } from '@lumina/shared';

// Re-export so callers of the Embedder can reference the required vector width
// from a single source of truth (Requirement 7.5).
export { EMBEDDING_DIMENSIONS };

/**
 * Maximum number of embedding attempts for a single Article. The Embedder makes
 * the first attempt plus retries until it succeeds or reaches this many total
 * attempts, after which storage is blocked (Requirements 7.6, 7.7).
 */
export const MAX_EMBEDDING_ATTEMPTS = 3;

/**
 * Abstraction over the external embedding API. Injected so the Embedder can run
 * against any backing model (OpenAI `text-embedding-3-small`, a stub, a fake in
 * tests, …) with no direct network dependency. Implementations should resolve
 * with the raw embedding vector and reject (throw) on transport/API errors;
 * dimension and finiteness are validated by the Embedder, not the client.
 */
export interface EmbeddingClient {
  /** Produce an embedding vector for `text`. Rejects on an API/transport error. */
  embed(text: string): Promise<number[]>;
}

/** Why a single embedding attempt did not yield a usable vector. */
export type EmbedAttemptReason =
  /** The injected client threw / rejected (transport or API error). */
  | 'client-error'
  /** The returned vector did not have exactly EMBEDDING_DIMENSIONS entries. */
  | 'invalid-dimension'
  /** The returned vector contained a non-finite value (NaN/±Infinity). */
  | 'invalid-values';

/** Diagnostic record for one failed embedding attempt. */
export interface EmbedAttemptError {
  /** 1-based attempt index (1 … MAX_EMBEDDING_ATTEMPTS). */
  attempt: number;
  /** Category of the failure. */
  reason: EmbedAttemptReason;
  /** Human-readable detail (e.g. the thrown message or the observed length). */
  message: string;
}

/**
 * Payload passed to the injected failure logger when embedding is abandoned
 * after the attempt budget is exhausted (Requirement 7.7).
 */
export interface EmbedFailureLog {
  /** Number of attempts made (equals {@link MAX_EMBEDDING_ATTEMPTS} on exhaustion). */
  attempts: number;
  /** Per-attempt diagnostics, in attempt order. */
  attemptErrors: EmbedAttemptError[];
}

/**
 * Callback invoked exactly once when embedding fails after exhausting all
 * attempts, so the caller can record the failure (Requirement 7.7). May be
 * synchronous or asynchronous; {@link embed} awaits the result before returning.
 */
export type EmbedFailureLogger = (failure: EmbedFailureLog) => void | Promise<void>;

/** Dependencies injected into {@link embed}. */
export interface EmbedDeps {
  /** The embedding API abstraction. */
  client: EmbeddingClient;
  /** Sink invoked once when all attempts are exhausted (logged failure, 7.7). */
  logFailure: EmbedFailureLogger;
}

/** Successful embedding: storage may proceed with this vector (Requirement 7.5). */
export interface EmbedSuccess {
  status: 'success';
  /** A validated vector of exactly {@link EMBEDDING_DIMENSIONS} finite numbers. */
  embedding: number[];
  /** Number of attempts made before success (1 … {@link MAX_EMBEDDING_ATTEMPTS}). */
  attempts: number;
}

/**
 * Terminal failure: the attempt budget was exhausted, so storage is blocked and
 * the Article must NOT be stored (Requirements 7.6, 7.7).
 */
export interface EmbedFailure {
  status: 'failure';
  /** Storage is blocked for this Article. Always `true` for a failure result. */
  storageBlocked: true;
  /** Number of attempts made (equals {@link MAX_EMBEDDING_ATTEMPTS}). */
  attempts: number;
  /** Per-attempt diagnostics, in attempt order. */
  attemptErrors: EmbedAttemptError[];
}

/** Discriminated outcome of embedding an Article's text. */
export type EmbedResult = EmbedSuccess | EmbedFailure;

/** Outcome of validating a candidate embedding vector. */
type ValidationOutcome =
  | { ok: true }
  | { ok: false; reason: Exclude<EmbedAttemptReason, 'client-error'>; message: string };

/**
 * Validate that `vector` is a usable embedding: exactly
 * {@link EMBEDDING_DIMENSIONS} entries, every one a finite number
 * (Requirement 7.5). Pure and total — never throws.
 */
export function validateEmbedding(vector: unknown): ValidationOutcome {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    const observed = Array.isArray(vector) ? `${vector.length}` : typeof vector;
    return {
      ok: false,
      reason: 'invalid-dimension',
      message: `expected ${EMBEDDING_DIMENSIONS} dimensions, received ${observed}`,
    };
  }
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
      return {
        ok: false,
        reason: 'invalid-values',
        message: `non-finite value at index ${i}`,
      };
    }
  }
  return { ok: true };
}

/** True iff `vector` is a usable {@link EMBEDDING_DIMENSIONS}-wide embedding. */
export function isValidEmbedding(vector: unknown): vector is number[] {
  return validateEmbedding(vector).ok;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Generate a 1536-dimension embedding for `text` before storage, with bounded
 * retries (Requirements 7.5–7.7, Property 9).
 *
 * The Embedder requests an embedding from the injected client and validates it
 * has exactly {@link EMBEDDING_DIMENSIONS} finite numbers. A thrown call or an
 * invalid result is retried until an attempt succeeds or
 * {@link MAX_EMBEDDING_ATTEMPTS} total attempts are made — the attempt count
 * never exceeds that maximum. On success it returns a `success` result carrying
 * the validated embedding (storage may proceed). On exhaustion it does NOT
 * throw: it invokes {@link EmbedDeps.logFailure} exactly once and returns a
 * `failure` result with `storageBlocked: true`, so the caller skips storing the
 * Article.
 */
export async function embed(text: string, deps: EmbedDeps): Promise<EmbedResult> {
  const attemptErrors: EmbedAttemptError[] = [];

  for (let attempt = 1; attempt <= MAX_EMBEDDING_ATTEMPTS; attempt++) {
    let vector: number[];
    try {
      vector = await deps.client.embed(text);
    } catch (err) {
      attemptErrors.push({ attempt, reason: 'client-error', message: errorMessage(err) });
      continue;
    }

    const validation = validateEmbedding(vector);
    if (validation.ok) {
      return { status: 'success', embedding: vector, attempts: attempt };
    }

    attemptErrors.push({ attempt, reason: validation.reason, message: validation.message });
  }

  // Budget exhausted: block storage and log the failure (Requirement 7.7).
  await deps.logFailure({ attempts: MAX_EMBEDDING_ATTEMPTS, attemptErrors });

  return {
    status: 'failure',
    storageBlocked: true,
    attempts: MAX_EMBEDDING_ATTEMPTS,
    attemptErrors,
  };
}

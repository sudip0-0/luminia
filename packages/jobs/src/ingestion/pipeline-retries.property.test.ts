// Feature: lumina, Property 9: Pipeline retries are bounded and end in a consistent terminal state
//
// Property-based test for the bounded-retry orchestrators of the two
// network-bound Ingestion_Pipeline stages: the Summarizer (`./summarizer.ts`)
// and the Embedder (`./embedder.ts`).
//
// Property 9 (design.md): For ANY sequence of summarization or embedding
// failures, the number of attempts never exceeds 3; on summarization
// exhaustion the article is retained in the unsummarized state and no further
// attempts occur; on embedding exhaustion the article is not stored.
//
// Strategy: each stage's only impure concern (the LLM / embedding API call) is
// injected, so we drive the orchestrator with a *fake client* scripted by a
// generated sequence of per-attempt behaviours (succeed / fail). The failing
// behaviours cover every rejection path the validators recognize:
//   - Summarizer: a thrown client error, plus several malformed-JSON shapes.
//   - Embedder:   a thrown client error, plus wrong-dimension and non-finite
//                 vectors.
// The generators deliberately cover the all-fail case and first-success at
// every attempt index k for k in 1..3 (within budget) and k > 3 (beyond
// budget, so the available success is never reached). For each generated
// sequence we compute the expected terminal state purely and assert:
//   - attempts <= 3 and the client is called at most 3 times;
//   - success exactly when a valid response arrives within the 3-attempt
//     budget, otherwise the terminal state — `unsummarized` for the Summarizer,
//     and `failure` with `storageBlocked: true` (storage NOT performed) for the
//     Embedder, with the failure logged exactly once;
//   - on exhaustion the client is called exactly 3 times (no further attempts).
//
// Each property runs a minimum of 100 generated iterations.
//
// Validates: Requirements 7.3, 7.4, 7.6, 7.7

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import {
  MAX_SUMMARIZER_ATTEMPTS,
  summarize,
  type AttemptFailure,
  type SummarizerArticleInput,
  type SummarizerClient,
} from './summarizer.js';
import {
  MAX_EMBEDDING_ATTEMPTS,
  embed,
  type EmbedFailureLog,
  type EmbeddingClient,
} from './embedder.js';

const RUNS = { numRuns: 300 } as const;

const ARTICLE: SummarizerArticleInput = {
  title: 'Property-tested article',
  fullText: 'Cleaned full text used only as context for the (fake) clients.',
};

// A fixed, non-empty taxonomy. Tags in a valid summarizer response must be
// drawn from this set.
const TAXONOMY = ['physics', 'machine-learning', 'biology', 'history', 'mathematics'] as const;

// --- Shared sequence model -------------------------------------------------
//
// A "step" describes one scripted client attempt: either it succeeds (the
// client returns a valid payload) or it fails with a specific failure flavour.

type SummFailKind = 'throw' | 'empty-object' | 'wrong-types' | 'null';
type SummStep = { success: true } | { success: false; fail: SummFailKind };

type EmbedFailKind = 'throw' | 'short' | 'long' | 'non-finite';
type EmbedStep = { success: true } | { success: false; fail: EmbedFailKind };

/**
 * The expected terminal outcome for a scripted sequence under a bounded budget
 * of `max` attempts. `firstSuccess` is the 1-based index of the first
 * succeeding step (Infinity when none). Because the orchestrator stops at the
 * first success OR after `max` attempts, a success beyond the budget is never
 * reached.
 */
function expected<S extends { success: boolean }>(steps: readonly S[], max: number) {
  const idx = steps.findIndex((s) => s.success);
  const firstSuccess = idx === -1 ? Number.POSITIVE_INFINITY : idx + 1;
  const willSucceed = firstSuccess <= max;
  const attempts = willSucceed ? firstSuccess : max;
  return { willSucceed, attempts, calls: attempts };
}

// --- Generators ------------------------------------------------------------

/**
 * Build a sequence generator from a per-step generator. Three branches
 * guarantee coverage of: arbitrary interleavings, all-fail sequences, and
 * first-success-at-attempt-k for k in 1..6 (k>3 lands beyond the budget).
 */
function sequenceArb<S extends { success: boolean }>(
  failStep: fc.Arbitrary<S>,
  successStep: S,
): fc.Arbitrary<S[]> {
  const anyStep = fc.oneof(failStep, fc.constant(successStep));
  return fc.oneof(
    // Arbitrary interleaving of successes and failures.
    fc.array(anyStep, { minLength: 1, maxLength: 6 }),
    // All-fail sequences of length 3..6 (always exhaust the budget).
    fc.array(failStep, { minLength: 3, maxLength: 6 }),
    // First success at a chosen attempt index k in 1..6: (k-1) failures then a
    // success. For k > 3 the success sits beyond the 3-attempt budget.
    fc
      .integer({ min: 1, max: 6 })
      .chain((k) =>
        fc.array(failStep, { minLength: k - 1, maxLength: k - 1 }).map((fails) => [
          ...fails,
          successStep,
        ]),
      ),
  );
}

const summFailStep: fc.Arbitrary<SummStep> = fc
  .constantFrom<SummFailKind>('throw', 'empty-object', 'wrong-types', 'null')
  .map((fail) => ({ success: false, fail }));

const embedFailStep: fc.Arbitrary<EmbedStep> = fc
  .constantFrom<EmbedFailKind>('throw', 'short', 'long', 'non-finite')
  .map((fail) => ({ success: false, fail }));

const summSeqArb = sequenceArb<SummStep>(summFailStep, { success: true });
const embedSeqArb = sequenceArb<EmbedStep>(embedFailStep, { success: true });

// A varied, always-valid raw summarizer response whose tags are drawn from the
// taxonomy. Validity is exhaustively covered by Property 8; here we only need a
// payload the validator accepts so the success branch is reachable.
const validRawArb = fc.record({
  // Each option has exactly 2 or 3 sentences per countSentences().
  summary: fc.constantFrom(
    'First sentence here. Second sentence follows.',
    'Alpha statement. Beta statement. Gamma statement.',
  ),
  tags: fc.uniqueArray(fc.constantFrom(...TAXONOMY), { minLength: 1, maxLength: 4 }),
  difficulty: fc.constantFrom('introductory', 'intermediate', 'advanced'),
  readTimeMinutes: fc.integer({ min: 1, max: 120 }),
});

// --- Fake clients ----------------------------------------------------------

/** Malformed summarizer payloads keyed by failure flavour (all rejected). */
const SUMM_MALFORMED: Record<Exclude<SummFailKind, 'throw'>, unknown> = {
  'empty-object': {},
  'wrong-types': { summary: 42, tags: 'not-an-array', difficulty: 'expert', readTimeMinutes: 'x' },
  null: null,
};

function makeSummarizerClient(
  steps: readonly SummStep[],
  validRaw: unknown,
): SummarizerClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    async summarize(): Promise<unknown> {
      client.calls++;
      // Beyond the scripted steps, keep failing (the orchestrator must stop on
      // its own at the attempt budget — never by exhausting the script).
      const step = steps[i++] ?? ({ success: false, fail: 'empty-object' } as SummStep);
      if (step.success) return validRaw;
      if (step.fail === 'throw') throw new Error('summarizer api error');
      return SUMM_MALFORMED[step.fail];
    },
  };
  return client;
}

/** A valid embedding: exactly EMBEDDING_DIMENSIONS finite numbers. */
function makeEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);
}

/** Build an invalid embedding for the given failure flavour. */
function badEmbedding(fail: Exclude<EmbedFailKind, 'throw'>): number[] {
  if (fail === 'short') return makeEmbedding().slice(0, 8);
  if (fail === 'long') return [...makeEmbedding(), 0.1];
  const withNaN = makeEmbedding();
  withNaN[0] = Number.NaN;
  return withNaN;
}

function makeEmbeddingClient(steps: readonly EmbedStep[]): EmbeddingClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    async embed(): Promise<number[]> {
      client.calls++;
      const step = steps[i++] ?? ({ success: false, fail: 'short' } as EmbedStep);
      if (step.success) return makeEmbedding();
      if (step.fail === 'throw') throw new Error('embedding api error');
      return badEmbedding(step.fail);
    },
  };
  return client;
}

// --- Properties ------------------------------------------------------------

describe('Pipeline retries are bounded and terminal — Property 9 (Requirements 7.3, 7.4, 7.6, 7.7)', () => {
  // Summarizer (Requirements 7.3, 7.4): attempts <= 3, the client is called at
  // most 3 times, the result is `summarized` exactly when a valid response
  // arrives within the budget, otherwise terminal `unsummarized` with no
  // further attempts after exhaustion.
  it('bounds Summarizer attempts and ends summarized-within-budget or terminal unsummarized', async () => {
    const scenario = fc.record({ steps: summSeqArb, validRaw: validRawArb });

    await fc.assert(
      fc.asyncProperty(scenario, async ({ steps, validRaw }) => {
        const client = makeSummarizerClient(steps, validRaw);
        const failures: AttemptFailure[] = [];

        const result = await summarize(ARTICLE, {
          client,
          taxonomySlugs: TAXONOMY,
          onAttemptFailed: (f) => failures.push(f),
        });

        const exp = expected(steps, MAX_SUMMARIZER_ATTEMPTS);

        // Bounded: never more than 3 attempts, and the client is called at most
        // 3 times (Requirements 7.3, 7.4).
        expect(client.calls).toBeLessThanOrEqual(MAX_SUMMARIZER_ATTEMPTS);
        expect(result.attempts).toBeLessThanOrEqual(MAX_SUMMARIZER_ATTEMPTS);
        expect(result.attempts).toBe(exp.attempts);
        expect(client.calls).toBe(exp.calls);

        if (exp.willSucceed) {
          expect(result.status).toBe('summarized');
        } else {
          // Terminal unsummarized state on exhaustion, and NO further attempts
          // occur: exactly 3 client calls and 3 recorded failures.
          expect(result.status).toBe('unsummarized');
          expect(result.attempts).toBe(MAX_SUMMARIZER_ATTEMPTS);
          expect(client.calls).toBe(MAX_SUMMARIZER_ATTEMPTS);
          expect(failures).toHaveLength(MAX_SUMMARIZER_ATTEMPTS);
        }
      }),
      RUNS,
    );
  });

  // Embedder (Requirements 7.6, 7.7): attempts <= 3, the client is called at
  // most 3 times, the result is `success` (carrying a valid 1536-dim vector)
  // exactly when a valid embedding arrives within the budget, otherwise
  // terminal `failure` with `storageBlocked: true` (the article is NOT stored)
  // and the failure logged exactly once.
  it('bounds Embedder attempts and ends success-within-budget or terminal storage-blocked failure', async () => {
    await fc.assert(
      fc.asyncProperty(embedSeqArb, async (steps) => {
        const client = makeEmbeddingClient(steps);
        const logged: EmbedFailureLog[] = [];

        const result = await embed('article text', {
          client,
          logFailure: (f) => {
            logged.push(f);
          },
        });

        const exp = expected(steps, MAX_EMBEDDING_ATTEMPTS);

        // Bounded: never more than 3 attempts, and the client is called at most
        // 3 times (Requirement 7.6).
        expect(client.calls).toBeLessThanOrEqual(MAX_EMBEDDING_ATTEMPTS);
        expect(result.attempts).toBeLessThanOrEqual(MAX_EMBEDDING_ATTEMPTS);
        expect(result.attempts).toBe(exp.attempts);
        expect(client.calls).toBe(exp.calls);

        if (exp.willSucceed) {
          expect(result.status).toBe('success');
          if (result.status === 'success') {
            expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
          }
          // No failure logged on success: storage may proceed.
          expect(logged).toHaveLength(0);
        } else {
          // Terminal failure on exhaustion: storage is blocked (article NOT
          // stored) and the failure is logged exactly once (Requirement 7.7).
          expect(result.status).toBe('failure');
          if (result.status === 'failure') {
            expect(result.storageBlocked).toBe(true);
            expect(result.attempts).toBe(MAX_EMBEDDING_ATTEMPTS);
          }
          expect(client.calls).toBe(MAX_EMBEDDING_ATTEMPTS);
          expect(logged).toHaveLength(1);
          expect(logged[0].attempts).toBe(MAX_EMBEDDING_ATTEMPTS);
        }
      }),
      RUNS,
    );
  });
});

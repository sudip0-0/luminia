// Feature: lumina, Property 8: Summarizer output respects all bounds
//
// Property-based test for the pure Summarizer validator and the bounded-retry
// orchestrator in `./summarizer.ts`.
//
// Property 8 (design.md): For any ACCEPTED Summarizer result, the summary
// contains 2-3 sentences, the tag count is between 1 and 4 with every tag drawn
// from the taxonomy, the difficulty ∈ {introductory, intermediate, advanced},
// the read time ∈ [1,120] minutes, and every produced topic association carries
// a confidence in [0.0, 1.0].
//
// The Summarizer splits into a pure, total validator
// (`validateSummarizerOutput`) and a thin orchestrator (`summarize`) whose only
// impure concern (the LLM call) is injected. This lets us exercise the bounds
// exhaustively without a network:
//   - For BOTH well-formed and malformed raw responses we assert the universal
//     implication: WHEN `validateSummarizerOutput` returns non-null (accepted),
//     the output satisfies ALL Requirement 7.1 bounds.
//   - Well-formed inputs are always accepted and normalized.
//   - Clearly out-of-bounds inputs (one field violated at a time, plus
//     non-objects) are always rejected (null).
//   - Driving `summarize` with a fake client that returns generated valid
//     outputs, every produced topic association confidence lies in [0,1]
//     (Requirement 7.2), regardless of model-supplied / out-of-range
//     confidences or the configured default.
//
// Each property runs a minimum of 100 generated iterations.
//
// Validates: Requirements 7.1, 7.2

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DIFFICULTIES } from '@lumina/shared';
import {
  validateSummarizerOutput,
  countSentences,
  summarize,
  MIN_SUMMARY_SENTENCES,
  MAX_SUMMARY_SENTENCES,
  MIN_TAGS,
  MAX_TAGS,
  MIN_READ_TIME_MINUTES,
  MAX_READ_TIME_MINUTES,
  type SummarizerArticleInput,
  type SummarizerClient,
} from './summarizer.js';

const RUNS = { numRuns: 300 } as const;

type RawRecord = Record<string, unknown>;

// --- Generators ------------------------------------------------------------

// A pool of taxonomy slugs. Real slugs are plain identifiers, so every value
// here is letters/hyphens only and cannot collide with the sentinel used to
// build out-of-taxonomy tags below.
const SLUG_POOL = [
  'physics',
  'machine-learning',
  'biology',
  'history',
  'mathematics',
  'chemistry',
  'economics',
  'philosophy',
  'astronomy',
  'geology',
  'linguistics',
  'psychology',
] as const;

// A non-empty taxonomy: a distinct subset of the slug pool.
const taxonomyArb: fc.Arbitrary<string[]> = fc.uniqueArray(fc.constantFrom(...SLUG_POOL), {
  minLength: 1,
  maxLength: SLUG_POOL.length,
});

// Sentence-building blocks: pure-letter words contain no terminal punctuation,
// so the sentence count produced below is exactly the number of segments.
const wordArb = fc.constantFrom(
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'study',
  'model',
  'result',
  'theory',
  'data',
  'method',
  'signal',
  'vector',
  'energy',
  'matter',
);

// One sentence: 1-5 words followed by a single terminal punctuation mark.
const sentenceArb = fc
  .tuple(fc.array(wordArb, { minLength: 1, maxLength: 5 }), fc.constantFrom('.', '!', '?'))
  .map(([words, terminator]) => words.join(' ') + terminator);

// A summary whose `countSentences` value is exactly within [min, max]. Because
// each sentence carries exactly one terminator and sentences are space-joined,
// `countSentences` returns the number of sentences.
const summaryWithSentenceCount = (min: number, max: number): fc.Arbitrary<string> =>
  fc.array(sentenceArb, { minLength: min, maxLength: max }).map((sentences) => sentences.join(' '));

// A well-formed raw response for the given taxonomy: 2-3 sentence summary, 1-4
// distinct in-taxonomy tags, a valid difficulty, and an integer read time in
// [1,120].
const validRawCoreArb = (slugs: readonly string[]): fc.Arbitrary<RawRecord> =>
  fc.record({
    summary: summaryWithSentenceCount(MIN_SUMMARY_SENTENCES, MAX_SUMMARY_SENTENCES),
    tags: fc.uniqueArray(fc.constantFrom(...slugs), {
      minLength: MIN_TAGS,
      maxLength: Math.min(MAX_TAGS, slugs.length),
    }),
    difficulty: fc.constantFrom(...DIFFICULTIES),
    readTimeMinutes: fc.integer({ min: MIN_READ_TIME_MINUTES, max: MAX_READ_TIME_MINUTES }),
  }) as fc.Arbitrary<RawRecord>;

// A fixed taxonomy (>= 5 slugs) used by the rejection property so that the
// "too many tags" mutation can draw >4 distinct in-taxonomy tags.
const FIXED_SLUGS = SLUG_POOL.slice(0, 8);
const FIXED_TAXONOMY = new Set<string>(FIXED_SLUGS);
const validRawForFixed = validRawCoreArb(FIXED_SLUGS);

// --- Assertion helper ------------------------------------------------------

// Asserts that a non-null validator output satisfies every Requirement 7.1
// bound against the supplied taxonomy.
function assertWithinBounds(
  output: ReturnType<typeof validateSummarizerOutput>,
  taxonomy: Set<string>,
): void {
  expect(output).not.toBeNull();
  if (output === null) return;

  // 2-3 sentences.
  const sentences = countSentences(output.summary);
  expect(sentences).toBeGreaterThanOrEqual(MIN_SUMMARY_SENTENCES);
  expect(sentences).toBeLessThanOrEqual(MAX_SUMMARY_SENTENCES);

  // 1-4 distinct tags, each drawn from the taxonomy.
  expect(output.tags.length).toBeGreaterThanOrEqual(MIN_TAGS);
  expect(output.tags.length).toBeLessThanOrEqual(MAX_TAGS);
  expect(new Set(output.tags).size).toBe(output.tags.length);
  for (const tag of output.tags) {
    expect(typeof tag).toBe('string');
    expect(taxonomy.has(tag)).toBe(true);
  }

  // Difficulty is one of the allowed levels.
  expect((DIFFICULTIES as readonly string[]).includes(output.difficulty)).toBe(true);

  // Read time: whole minutes in [1,120].
  expect(Number.isInteger(output.readTimeMinutes)).toBe(true);
  expect(output.readTimeMinutes).toBeGreaterThanOrEqual(MIN_READ_TIME_MINUTES);
  expect(output.readTimeMinutes).toBeLessThanOrEqual(MAX_READ_TIME_MINUTES);
}

const ARTICLE: SummarizerArticleInput = {
  title: 'Property-tested article',
  fullText: 'Cleaned full text used only as context for the (fake) model client.',
};

describe('Summarizer output bounds — Property 8 (Requirements 7.1, 7.2)', () => {
  // Property 8 (core): the universal implication. For ANY raw input (well-formed
  // or arbitrary/malformed), WHEN the validator accepts it the output respects
  // every bound. Arbitrary inputs exercise the rejection branch broadly while
  // well-formed inputs exercise the acceptance branch.
  it('every accepted result respects all bounds, over well-formed and arbitrary inputs', () => {
    fc.assert(
      fc.property(
        taxonomyArb.chain((slugs) =>
          fc.record({
            slugs: fc.constant(slugs),
            raw: fc.oneof(
              { weight: 3, arbitrary: validRawCoreArb(slugs) as fc.Arbitrary<unknown> },
              { weight: 1, arbitrary: fc.anything() },
            ),
          }),
        ),
        ({ slugs, raw }) => {
          const taxonomy = new Set(slugs);
          const output = validateSummarizerOutput(raw, taxonomy);
          // The implication: acceptance ⇒ all bounds hold.
          if (output !== null) {
            assertWithinBounds(output, taxonomy);
          }
        },
      ),
      RUNS,
    );
  });

  // Property 8 (acceptance): well-formed inputs are always accepted and the
  // output is the normalized projection of the input. Guarantees the accepted
  // set is non-trivial.
  it('always accepts well-formed inputs and normalizes them', () => {
    fc.assert(
      fc.property(
        taxonomyArb.chain((slugs) =>
          validRawCoreArb(slugs).map((raw) => ({ slugs, raw })),
        ),
        ({ slugs, raw }) => {
          const taxonomy = new Set(slugs);
          const output = validateSummarizerOutput(raw, taxonomy);
          assertWithinBounds(output, taxonomy);
          expect(output).toEqual({
            summary: raw.summary,
            tags: raw.tags,
            difficulty: raw.difficulty,
            readTimeMinutes: raw.readTimeMinutes,
          });
        },
      ),
      RUNS,
    );
  });

  // Property 8 (rejection): clearly out-of-bounds inputs are rejected. Each
  // generated input either violates exactly one field of an otherwise-valid
  // response or is not a plain object.
  it('always rejects clearly out-of-bounds inputs (returns null)', () => {
    // Summaries that never have 2-3 sentences (or are non-strings).
    const invalidSummary = fc.oneof(
      summaryWithSentenceCount(1, 1),
      summaryWithSentenceCount(4, 7),
      fc.constant(''),
      fc.constant('   '),
      fc.constant('...!?'),
      fc.integer(),
      fc.constant(null),
      fc.boolean(),
    );

    // Tag lists that violate count / membership / distinctness / element type,
    // or are not arrays.
    const invalidTags = fc.oneof(
      fc.constant([]),
      fc.uniqueArray(fc.constantFrom(...FIXED_SLUGS), {
        minLength: MAX_TAGS + 1,
        maxLength: FIXED_SLUGS.length,
      }),
      fc.constant([FIXED_SLUGS[0], '__not_in_taxonomy__']),
      fc.constant([FIXED_SLUGS[0], FIXED_SLUGS[0]]),
      fc.constant([FIXED_SLUGS[0], 5]),
      fc.constant('not-an-array'),
      fc.integer(),
    );

    const invalidDifficulty = fc.oneof(
      fc.constantFrom('expert', 'easy', 'hard', 'beginner', ''),
      fc.integer(),
      fc.constant(null),
      fc.boolean(),
    );

    const nonIntegerReadTime = fc
      .double({ min: 1, max: 120, noNaN: true })
      .filter((n) => !Number.isInteger(n));
    const invalidReadTime = fc.oneof(
      fc.integer({ min: -1000, max: MIN_READ_TIME_MINUTES - 1 }),
      fc.integer({ min: MAX_READ_TIME_MINUTES + 1, max: 100_000 }),
      nonIntegerReadTime,
      fc.constant(7.5),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant('7'),
      fc.constant(null),
    );

    // Overwrite exactly one field of a valid base with an invalid value.
    const mutate = (field: string, arb: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> =>
      validRawForFixed.chain((base) => arb.map((value) => ({ ...base, [field]: value })));

    const invalidRawArb = fc.oneof(
      mutate('summary', invalidSummary),
      mutate('tags', invalidTags),
      mutate('difficulty', invalidDifficulty),
      mutate('readTimeMinutes', invalidReadTime),
      // Non-object raws are rejected outright.
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.anything()),
    );

    fc.assert(
      fc.property(invalidRawArb, (raw) => {
        expect(validateSummarizerOutput(raw, FIXED_TAXONOMY)).toBeNull();
      }),
      RUNS,
    );
  });

  // Property 8 (confidence): driving `summarize` with a fake client that returns
  // generated valid outputs, every produced topic association carries a finite
  // confidence in [0,1] — regardless of model-supplied confidences (possibly
  // out-of-range / NaN / non-numeric / missing) or the configured default.
  it('produces topic association confidences within [0,1] for every accepted summary', async () => {
    const scenario = taxonomyArb.chain((slugs) =>
      validRawCoreArb(slugs).chain((core) => {
        const tags = core.tags as string[];
        const confidencesArb = fc.option(
          fc.dictionary(
            fc.oneof(fc.constantFrom(...tags), fc.string()),
            fc.oneof(
              fc.double(),
              fc.constant(Number.NaN),
              fc.constant(Number.POSITIVE_INFINITY),
              fc.constant(Number.NEGATIVE_INFINITY),
              fc.string(),
              fc.constant(null),
              fc.boolean(),
            ),
          ),
          { nil: undefined },
        );
        return fc.record({
          slugs: fc.constant(slugs),
          raw: confidencesArb.map((confidences) =>
            confidences === undefined ? core : { ...core, confidences },
          ),
          defaultConfidence: fc.oneof(fc.constant(undefined), fc.double()),
        });
      }),
    );

    await fc.assert(
      fc.asyncProperty(scenario, async ({ slugs, raw, defaultConfidence }) => {
        const client: SummarizerClient = {
          async summarize() {
            return raw;
          },
        };
        const result = await summarize(ARTICLE, {
          client,
          taxonomySlugs: slugs,
          defaultConfidence,
        });

        // A valid raw response is always accepted on the first attempt.
        expect(result.status).toBe('summarized');
        if (result.status !== 'summarized') return;

        // The accepted output still respects every structural bound.
        assertWithinBounds(result.output, new Set(slugs));

        // One association per tag, each with a finite confidence in [0,1].
        expect(result.topics).toHaveLength(result.output.tags.length);
        for (const topic of result.topics) {
          expect(slugs).toContain(topic.slug);
          expect(Number.isFinite(topic.confidence)).toBe(true);
          expect(topic.confidence).toBeGreaterThanOrEqual(0);
          expect(topic.confidence).toBeLessThanOrEqual(1);
        }
      }),
      RUNS,
    );
  });
});

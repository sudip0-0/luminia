import { describe, it, expect, vi } from 'vitest';
import {
  summarize,
  validateSummarizerOutput,
  countSentences,
  MAX_SUMMARIZER_ATTEMPTS,
  DEFAULT_TOPIC_CONFIDENCE,
  type SummarizerArticleInput,
  type SummarizerClient,
  type AttemptFailure,
} from './summarizer.js';

/** Taxonomy slug set reused across tests. */
const TAXONOMY = new Set(['physics', 'machine-learning', 'biology', 'history', 'mathematics']);

/** A representative article input. */
const ARTICLE: SummarizerArticleInput = {
  title: 'A New Result',
  fullText: 'Some cleaned body text used as context for the model.',
};

/** A well-formed raw model response that should validate. */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'First sentence about the topic. Second sentence with more detail. Third wraps it up.',
    tags: ['physics', 'mathematics'],
    difficulty: 'intermediate',
    readTimeMinutes: 7,
    ...overrides,
  };
}

/**
 * A fake client that returns each queued response in order. Records how many
 * times it was called so attempt-counting can be asserted. Items may be a
 * value (resolved) or an Error (rejected) to simulate transport failures.
 */
function fakeClient(responses: Array<unknown | Error>): SummarizerClient & { calls: number } {
  const queue = [...responses];
  return {
    calls: 0,
    async summarize() {
      this.calls++;
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('countSentences', () => {
  it('counts terminal-punctuation-delimited sentences', () => {
    expect(countSentences('One. Two. Three.')).toBe(3);
    expect(countSentences('Only one sentence here.')).toBe(1);
    expect(countSentences('Two sentences! Without a trailing period')).toBe(2);
  });

  it('treats blank or punctuation-only text as zero sentences', () => {
    expect(countSentences('')).toBe(0);
    expect(countSentences('   ')).toBe(0);
    expect(countSentences('...!?')).toBe(0);
  });
});

describe('validateSummarizerOutput', () => {
  it('accepts a well-formed response within all bounds', () => {
    const output = validateSummarizerOutput(validRaw(), TAXONOMY);
    expect(output).toEqual({
      summary: validRaw().summary,
      tags: ['physics', 'mathematics'],
      difficulty: 'intermediate',
      readTimeMinutes: 7,
    });
  });

  it('accepts a two-sentence summary and a single tag at the lower bounds', () => {
    const output = validateSummarizerOutput(
      validRaw({ summary: 'Sentence one. Sentence two.', tags: ['biology'] }),
      TAXONOMY,
    );
    expect(output?.tags).toEqual(['biology']);
  });

  it('rejects non-object responses', () => {
    expect(validateSummarizerOutput(null, TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput('a string', TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(['array'], TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(42, TAXONOMY)).toBeNull();
  });

  it('rejects a summary with too few or too many sentences', () => {
    expect(validateSummarizerOutput(validRaw({ summary: 'Just one sentence.' }), TAXONOMY)).toBeNull();
    expect(
      validateSummarizerOutput(validRaw({ summary: 'One. Two. Three. Four.' }), TAXONOMY),
    ).toBeNull();
  });

  it('rejects a missing or non-string summary', () => {
    expect(validateSummarizerOutput(validRaw({ summary: undefined }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ summary: 123 }), TAXONOMY)).toBeNull();
  });

  it('rejects an empty tag list and a list longer than four', () => {
    expect(validateSummarizerOutput(validRaw({ tags: [] }), TAXONOMY)).toBeNull();
    expect(
      validateSummarizerOutput(
        validRaw({ tags: ['physics', 'biology', 'history', 'mathematics', 'machine-learning'] }),
        TAXONOMY,
      ),
    ).toBeNull();
  });

  it('rejects tags not drawn from the taxonomy', () => {
    expect(validateSummarizerOutput(validRaw({ tags: ['not-a-real-topic'] }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ tags: ['physics', 'unknown'] }), TAXONOMY)).toBeNull();
  });

  it('rejects duplicate tags', () => {
    expect(validateSummarizerOutput(validRaw({ tags: ['physics', 'physics'] }), TAXONOMY)).toBeNull();
  });

  it('rejects non-string tag entries', () => {
    expect(validateSummarizerOutput(validRaw({ tags: ['physics', 5] }), TAXONOMY)).toBeNull();
  });

  it('rejects an invalid difficulty', () => {
    expect(validateSummarizerOutput(validRaw({ difficulty: 'expert' }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ difficulty: 2 }), TAXONOMY)).toBeNull();
  });

  it('rejects read times outside [1, 120]', () => {
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: 0 }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: 121 }), TAXONOMY)).toBeNull();
  });

  it('rejects non-integer read times', () => {
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: 7.5 }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: '7' }), TAXONOMY)).toBeNull();
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: Number.NaN }), TAXONOMY)).toBeNull();
  });

  it('accepts the inclusive read-time boundaries', () => {
    expect(validateSummarizerOutput(validRaw({ readTimeMinutes: 1 }), TAXONOMY)?.readTimeMinutes).toBe(1);
    expect(
      validateSummarizerOutput(validRaw({ readTimeMinutes: 120 }), TAXONOMY)?.readTimeMinutes,
    ).toBe(120);
  });

  it('accepts an iterable (array) taxonomy as well as a Set', () => {
    const output = validateSummarizerOutput(validRaw({ tags: ['physics'] }), ['physics', 'biology']);
    expect(output?.tags).toEqual(['physics']);
  });
});

describe('summarize (orchestrator)', () => {
  it('returns a summarized result with topic associations on a valid first response', async () => {
    const client = fakeClient([validRaw({ tags: ['physics', 'biology'] })]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('summarized');
    if (result.status !== 'summarized') return;
    expect(result.attempts).toBe(1);
    expect(client.calls).toBe(1);
    expect(result.output.tags).toEqual(['physics', 'biology']);
    expect(result.topics).toEqual([
      { slug: 'physics', confidence: DEFAULT_TOPIC_CONFIDENCE },
      { slug: 'biology', confidence: DEFAULT_TOPIC_CONFIDENCE },
    ]);
  });

  it('uses model-supplied confidences clamped to [0,1] when present', async () => {
    const client = fakeClient([
      validRaw({ tags: ['physics', 'biology'], confidences: { physics: 0.42, biology: 5 } }),
    ]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('summarized');
    if (result.status !== 'summarized') return;
    expect(result.topics).toEqual([
      { slug: 'physics', confidence: 0.42 },
      { slug: 'biology', confidence: 1 }, // 5 clamped to 1
    ]);
  });

  it('retries malformed responses then succeeds within the attempt budget', async () => {
    const failures: AttemptFailure[] = [];
    const client = fakeClient([
      { summary: 'broken' }, // malformed: no tags/difficulty/readTime
      validRaw(),
    ]);
    const result = await summarize(ARTICLE, {
      client,
      taxonomySlugs: TAXONOMY,
      onAttemptFailed: (f) => failures.push(f),
    });

    expect(result.status).toBe('summarized');
    if (result.status !== 'summarized') return;
    expect(result.attempts).toBe(2);
    expect(client.calls).toBe(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.attempt).toBe(1);
  });

  it('leaves the article unsummarized after exhausting 3 malformed attempts', async () => {
    const failures: AttemptFailure[] = [];
    const client = fakeClient([{ bad: 1 }, { bad: 2 }, { bad: 3 }, validRaw()]);
    const result = await summarize(ARTICLE, {
      client,
      taxonomySlugs: TAXONOMY,
      onAttemptFailed: (f) => failures.push(f),
    });

    expect(result.status).toBe('unsummarized');
    expect(result.attempts).toBe(MAX_SUMMARIZER_ATTEMPTS);
    // The 4th queued (valid) response is never requested once attempts are exhausted.
    expect(client.calls).toBe(MAX_SUMMARIZER_ATTEMPTS);
    expect(failures).toHaveLength(MAX_SUMMARIZER_ATTEMPTS);
  });

  it('treats a thrown client error as a failed attempt and retries', async () => {
    const client = fakeClient([new Error('network down'), validRaw()]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('summarized');
    if (result.status !== 'summarized') return;
    expect(result.attempts).toBe(2);
  });

  it('does not throw when every attempt rejects', async () => {
    const client = fakeClient([new Error('a'), new Error('b'), new Error('c')]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('unsummarized');
    expect(result.attempts).toBe(MAX_SUMMARIZER_ATTEMPTS);
  });

  it('rejects (as unsummarized) a bound violation: read time over 120', async () => {
    const client = fakeClient([
      validRaw({ readTimeMinutes: 200 }),
      validRaw({ readTimeMinutes: 200 }),
      validRaw({ readTimeMinutes: 200 }),
    ]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('unsummarized');
    expect(client.calls).toBe(MAX_SUMMARIZER_ATTEMPTS);
  });

  it('rejects (as unsummarized) a bound violation: too many tags', async () => {
    const tooMany = validRaw({
      tags: ['physics', 'biology', 'history', 'mathematics', 'machine-learning'],
    });
    const client = fakeClient([tooMany, tooMany, tooMany]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });

    expect(result.status).toBe('unsummarized');
  });

  it('honours a custom maxAttempts', async () => {
    const client = fakeClient([{ bad: 1 }, validRaw()]);
    const result = await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY, maxAttempts: 1 });

    expect(result.status).toBe('unsummarized');
    expect(result.attempts).toBe(1);
    expect(client.calls).toBe(1);
  });

  it('applies a custom default confidence', async () => {
    const client = fakeClient([validRaw({ tags: ['physics'] })]);
    const result = await summarize(ARTICLE, {
      client,
      taxonomySlugs: TAXONOMY,
      defaultConfidence: 0.6,
    });

    expect(result.status).toBe('summarized');
    if (result.status !== 'summarized') return;
    expect(result.topics).toEqual([{ slug: 'physics', confidence: 0.6 }]);
  });

  it('never calls the client more than maxAttempts times', async () => {
    const client = fakeClient([]);
    const summarizeSpy = vi.spyOn(client, 'summarize');
    await summarize(ARTICLE, { client, taxonomySlugs: TAXONOMY });
    expect(summarizeSpy.mock.calls.length).toBeLessThanOrEqual(MAX_SUMMARIZER_ATTEMPTS);
  });
});

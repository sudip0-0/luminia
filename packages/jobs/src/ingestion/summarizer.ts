// Summarizer — Ingestion_Pipeline component (Requirements 7.1, 7.2, 7.3, 7.4).
//
// The Summarizer asks the Claude API to produce, for an Article, a structured
// result: a 2-3 sentence summary, 1-4 taxonomy tags, a difficulty, and a read
// time of 1-120 minutes (Requirement 7.1). The returned tags are associated
// with the corresponding Topics, each carrying a confidence in [0.0, 1.0]
// (Requirement 7.2). Malformed (non-conforming) responses are rejected and
// retried up to a maximum of 3 attempts; on exhaustion the Article is left in
// a terminal "unsummarized" state and no further attempts occur — the
// orchestrator never throws (Requirements 7.3, 7.4).
//
// The design splits cleanly into a PURE, total validator
// (`validateSummarizerOutput`) that is cheap to property-test, and a thin
// orchestrator (`summarize`) whose only impure concern — the LLM call — is
// injected via the {@link SummarizerClient} interface so tests run without a
// network. Design references: Requirements 7.1-7.4, Property 8, Property 9.

import { DIFFICULTIES, type Difficulty, type SummarizerOutput } from '@lumina/shared';

/**
 * Maximum number of summarization attempts before the Article is left
 * unsummarized (Requirements 7.3, 7.4). Including the first attempt, the
 * Summarizer is invoked at most this many times for a single Article.
 */
export const MAX_SUMMARIZER_ATTEMPTS = 3;

/** Minimum and maximum sentence count for an accepted summary (Requirement 7.1). */
export const MIN_SUMMARY_SENTENCES = 2;
export const MAX_SUMMARY_SENTENCES = 3;

/** Minimum and maximum tag count for an accepted result (Requirement 7.1). */
export const MIN_TAGS = 1;
export const MAX_TAGS = 4;

/** Inclusive read-time bounds, in whole minutes, for an accepted result (Requirement 7.1). */
export const MIN_READ_TIME_MINUTES = 1;
export const MAX_READ_TIME_MINUTES = 120;

/** Confidence applied to a tag association when the model supplies none (Requirement 7.2). */
export const DEFAULT_TOPIC_CONFIDENCE = 1.0;

/**
 * Minimal Article projection handed to the {@link SummarizerClient}. The
 * Summarizer runs before the embedding and read-time stages, so it depends only
 * on the fields available at that point — the title and cleaned full text. A
 * narrow input keeps the module decoupled from the full {@link Article} shape.
 */
export interface SummarizerArticleInput {
  /** Article title, provided to the model as context. */
  title: string;
  /** Cleaned full text to summarize; null/empty when unavailable. */
  fullText: string | null;
}

/**
 * Abstraction over the Claude API call. The single method returns the raw,
 * untrusted model response as `unknown`; validation and bounds-checking are the
 * orchestrator's responsibility. Injecting this interface lets tests supply a
 * fake client (returning canned valid/malformed payloads) with no network I/O.
 */
export interface SummarizerClient {
  /** Request a structured summary for the given article. May reject or return malformed data. */
  summarize(article: SummarizerArticleInput): Promise<unknown>;
}

/** An Article↔Topic association produced from an accepted result (Requirement 7.2). */
export interface TopicAssociation {
  /** Taxonomy slug of the associated topic. */
  slug: string;
  /** Confidence of the association, guaranteed to lie in [0.0, 1.0]. */
  confidence: number;
}

/**
 * Outcome of running the Summarizer for one Article. Either the article was
 * summarized within the attempt budget, or every attempt failed and the article
 * is left in the terminal `unsummarized` state (Requirement 7.4).
 */
export type SummarizeResult =
  | {
      readonly status: 'summarized';
      /** The validated, in-bounds Summarizer output. */
      readonly output: SummarizerOutput;
      /** Topic associations, one per tag, each with a confidence in [0,1]. */
      readonly topics: readonly TopicAssociation[];
      /** Number of attempts made (1..maxAttempts). */
      readonly attempts: number;
    }
  | {
      readonly status: 'unsummarized';
      /** Number of attempts made before giving up (equals maxAttempts on exhaustion). */
      readonly attempts: number;
    };

/** Diagnostic payload reported for each failed attempt (malformed response or thrown error). */
export interface AttemptFailure {
  /** 1-based attempt index that failed. */
  attempt: number;
  /** The raw response that failed validation, if the client returned one. */
  raw?: unknown;
  /** The error thrown by the client, if the call rejected. */
  error?: unknown;
}

/** Dependencies injected into the {@link summarize} orchestrator. */
export interface SummarizeDeps {
  /** The (possibly fake) LLM client performing the summarization call. */
  client: SummarizerClient;
  /** The set of valid taxonomy slugs every returned tag must be drawn from. */
  taxonomySlugs: Iterable<string>;
  /** Maximum attempts; defaults to {@link MAX_SUMMARIZER_ATTEMPTS}. */
  maxAttempts?: number;
  /** Confidence used when the model supplies none; defaults to {@link DEFAULT_TOPIC_CONFIDENCE}. */
  defaultConfidence?: number;
  /** Optional sink invoked once per failed attempt, for logging/metrics. */
  onAttemptFailed?: (failure: AttemptFailure) => void;
}

/** Clamp `value` into [0, 1]; non-finite values map to 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Narrowing guard for a non-null plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Count the sentences in `text` using a deterministic heuristic: split on runs
 * of terminal punctuation (`.`, `!`, `?`) and count the resulting segments that
 * contain at least one letter or digit. A trailing word-bearing segment without
 * terminal punctuation still counts as one sentence, so "A. B" counts as 2.
 * Pure and total; non-strings and blank input yield 0.
 */
export function countSentences(text: string): number {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (const segment of text.split(/[.!?]+/)) {
    if (/[\p{L}\p{N}]/u.test(segment)) count++;
  }
  return count;
}

/**
 * Validate a raw, untrusted Summarizer response against the required JSON
 * structure and all Requirement 7.1 bounds, returning a typed
 * {@link SummarizerOutput} when every check passes and `null` otherwise
 * (Requirement 7.3 — a non-conforming response is rejected). Pure and total: it
 * never throws and performs no I/O.
 *
 * A response is accepted iff:
 * - it is a plain object;
 * - `summary` is a string containing 2-3 sentences;
 * - `tags` is an array of 1-4 distinct strings, each drawn from
 *   `taxonomySlugs`;
 * - `difficulty` is one of `introductory`, `intermediate`, `advanced`;
 * - `readTimeMinutes` is an integer in [1, 120].
 */
export function validateSummarizerOutput(
  raw: unknown,
  taxonomySlugs: Iterable<string>,
): SummarizerOutput | null {
  if (!isRecord(raw)) return null;

  // summary: a string of 2-3 sentences.
  const { summary } = raw;
  if (typeof summary !== 'string') return null;
  const sentences = countSentences(summary);
  if (sentences < MIN_SUMMARY_SENTENCES || sentences > MAX_SUMMARY_SENTENCES) return null;

  // tags: 1-4 distinct strings, each a known taxonomy slug.
  const { tags } = raw;
  if (!Array.isArray(tags)) return null;
  if (tags.length < MIN_TAGS || tags.length > MAX_TAGS) return null;
  const slugSet = taxonomySlugs instanceof Set ? taxonomySlugs : new Set(taxonomySlugs);
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') return null;
    if (!slugSet.has(tag)) return null;
    if (seen.has(tag)) return null; // duplicate tag ⇒ malformed
    seen.add(tag);
  }

  // difficulty: one of the three allowed levels.
  const { difficulty } = raw;
  if (typeof difficulty !== 'string') return null;
  if (!(DIFFICULTIES as readonly string[]).includes(difficulty)) return null;

  // readTimeMinutes: whole number in [1, 120].
  const { readTimeMinutes } = raw;
  if (typeof readTimeMinutes !== 'number' || !Number.isInteger(readTimeMinutes)) return null;
  if (readTimeMinutes < MIN_READ_TIME_MINUTES || readTimeMinutes > MAX_READ_TIME_MINUTES) {
    return null;
  }

  return {
    summary,
    tags: [...tags] as string[],
    difficulty: difficulty as Difficulty,
    readTimeMinutes,
  };
}

/**
 * Read a per-tag confidence from the raw response's optional `confidences`
 * map. Returns the model-supplied value when it is a finite number, otherwise
 * `null` so the caller can apply its default.
 */
function readConfidence(raw: unknown, slug: string): number | null {
  if (!isRecord(raw)) return null;
  const { confidences } = raw;
  if (!isRecord(confidences)) return null;
  const value = confidences[slug];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Run the Summarizer for one Article with bounded retries. Calls the injected
 * client, validates the response, and on a malformed response (or a client
 * error) retries up to `maxAttempts` total attempts (default
 * {@link MAX_SUMMARIZER_ATTEMPTS} = 3). On the first accepted response it
 * returns the validated {@link SummarizerOutput} together with one
 * {@link TopicAssociation} per tag — each confidence clamped to [0,1], taken
 * from the model's `confidences` map when present, otherwise
 * `defaultConfidence` (Requirements 7.1, 7.2). If every attempt fails it
 * returns a terminal `unsummarized` result and never throws (Requirements 7.3,
 * 7.4).
 */
export async function summarize(
  article: SummarizerArticleInput,
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  const maxAttempts = Math.max(0, Math.floor(deps.maxAttempts ?? MAX_SUMMARIZER_ATTEMPTS));
  const slugSet = deps.taxonomySlugs instanceof Set ? deps.taxonomySlugs : new Set(deps.taxonomySlugs);
  const defaultConfidence = clamp01(deps.defaultConfidence ?? DEFAULT_TOPIC_CONFIDENCE);

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;

    let raw: unknown;
    try {
      raw = await deps.client.summarize(article);
    } catch (error) {
      deps.onAttemptFailed?.({ attempt, error });
      continue;
    }

    const output = validateSummarizerOutput(raw, slugSet);
    if (output === null) {
      deps.onAttemptFailed?.({ attempt, raw });
      continue;
    }

    const topics: TopicAssociation[] = output.tags.map((slug) => {
      const supplied = readConfidence(raw, slug);
      return {
        slug,
        confidence: supplied === null ? defaultConfidence : clamp01(supplied),
      };
    });

    return { status: 'summarized', output, topics, attempts: attempt };
  }

  return { status: 'unsummarized', attempts: attempt };
}

// Ingestion_Pipeline orchestration with per-source failure isolation
// (Requirements 5.2, 5.6, 5.7).
//
// This module composes the already-implemented, independently-tested pipeline
// components into the two orchestration entry points the Scheduler drives:
//
//   - `processItem` runs ONE RawContentItem through the pipeline stages in the
//     order mandated by Requirement 5.2:
//         Deduplicator → Quality_Scorer → Summarizer → Embedder →
//         Read_Time_Estimator → storage
//     short-circuiting whenever a stage rejects the item (a duplicate is
//     discarded, a sub-threshold quality score is rejected, and a summarizer or
//     embedder exhaustion skips storage), so a single item never half-persists.
//
//   - `runIngestionForSources` crawls each source (via `crawlSince`) and
//     processes its items, isolating failures per source: a crawl that times
//     out after >30s or returns an error/non-2xx response (surfaced as a thrown
//     CrawlError or any other error) records a `crawl_failure` entry that
//     identifies the source and then CONTINUES with the remaining sources
//     (Requirement 5.6). Even when recording the failure itself throws, the
//     cycle still continues (Requirement 5.7).
//
// Every external concern — the dedup hash lookup, the summarizer/embedder API
// clients, the storage repository and search index, the crawl-state store, the
// crawl-failure recorder, and the 30-second timeout — is INJECTED, so both
// entry points are unit-testable with fakes and never touch the network or a
// database. The 30s timeout is applied through an injectable wrapper so tests
// never depend on a real long-running timer.

import type { Source } from '@lumina/shared';
import {
  Deduplicator,
  type DuplicateRecorder,
  type ExistingHashLookup,
} from './dedup.js';
import {
  IDEAL_GRADE_MAX,
  IDEAL_GRADE_MIN,
  meetsQualityThreshold,
  scoreQuality,
} from './quality-scorer.js';
import { summarize, type AttemptFailure, type SummarizerClient } from './summarizer.js';
import { embed, type EmbeddingClient, type EmbedFailureLogger } from './embedder.js';
import { MIN_READ_TIME_MINUTES, estimateReadTimeMinutes } from './read-time.js';
import {
  storeArticle,
  type ArticleSearchIndex,
  type ArticleStore,
  type CompletenessField,
} from './storage-gate.js';
import { crawlSince } from '../crawlers/crawl-since.js';
import type {
  Crawler,
  CrawlStateStore,
  CrawlWindow,
  RawContentItem,
} from '../crawlers/types.js';

/**
 * Default per-source crawl timeout, in milliseconds. A crawl that has not
 * produced a successful response within this budget is treated as a failure
 * (Requirement 5.6). Applied through an injectable {@link TimeoutWrapper} so it
 * can be replaced in tests.
 */
export const DEFAULT_CRAWL_TIMEOUT_MS = 30_000;

/**
 * Reading grade used by the Quality_Scorer when the caller supplies no
 * per-item reading-level estimator. The midpoint of the ideal band so the
 * reading-level sub-score is not penalized by default and quality is driven by
 * content length and source tier.
 */
const DEFAULT_READING_GRADE = (IDEAL_GRADE_MIN + IDEAL_GRADE_MAX) / 2;

/** Extract a human-readable message from an arbitrary thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Count the words in `text` using a deterministic whitespace split. Empty or
 * whitespace-only input yields 0. Pure and total.
 */
export function countWords(text: string): number {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

/** Default reading-grade estimator: a constant inside the ideal band. */
function defaultReadingGrade(): number {
  return DEFAULT_READING_GRADE;
}

/** Text handed to the Embedder: the title and body combined. */
function embeddingText(item: RawContentItem): string {
  return `${item.title}\n\n${item.body}`;
}

/**
 * Dependencies injected into {@link processItem}. Each field corresponds to the
 * external concern of one pipeline stage; the pure stages (Quality_Scorer,
 * Read_Time_Estimator) take only optional tuning. Nothing here performs I/O on
 * its own — the orchestrator wires the injected collaborators together.
 */
export interface ProcessItemDeps {
  // --- Deduplicator (Requirements 6.1, 6.2) ---
  /** Lookup over stored URL hashes used to detect a duplicate. */
  dedupLookup: ExistingHashLookup;
  /** Optional sink invoked once per discarded duplicate. */
  recordRejectedDuplicate?: DuplicateRecorder;

  // --- Quality_Scorer (Requirements 6.3, 6.4) ---
  /**
   * Optional per-item reading-grade estimator feeding the Quality_Scorer.
   * Defaults to a constant inside the ideal band when omitted.
   */
  readingGradeLevel?: (item: RawContentItem) => number;

  // --- Summarizer (Requirements 7.1–7.4) ---
  /** The (possibly fake) Claude API client performing summarization. */
  summarizerClient: SummarizerClient;
  /** Valid taxonomy slugs every returned tag must be drawn from. */
  taxonomySlugs: Iterable<string>;
  /** Optional override for the maximum summarization attempts. */
  maxSummarizerAttempts?: number;
  /** Optional confidence applied when the model supplies none. */
  defaultTopicConfidence?: number;
  /** Optional sink invoked once per failed summarization attempt. */
  onSummarizerAttemptFailed?: (failure: AttemptFailure) => void;

  // --- Embedder (Requirements 7.5–7.7) ---
  /** The (possibly fake) embedding API client. */
  embeddingClient: EmbeddingClient;
  /** Sink invoked once when embedding fails after exhausting its attempts. */
  logEmbeddingFailure: EmbedFailureLogger;

  // --- Read_Time_Estimator (Requirement 6.6) ---
  /** Optional reading speed (words per minute) for the read-time fallback. */
  wordsPerMinute?: number;

  // --- Storage completeness gate (Requirements 6.5, 7.5) ---
  /** Persists a complete Article (e.g. the PostgreSQL articles repository). */
  repository: ArticleStore;
  /** Indexes the stored Article for search (e.g. the Typesense articles index). */
  searchIndex: ArticleSearchIndex;
}

/** Discriminated outcome of running one item through the pipeline. */
export type ProcessItemResult =
  /** The item was persisted and indexed. */
  | { status: 'stored'; id: string; readTimeMinutes: number; qualityScore: number }
  /** The Deduplicator discarded the item as a URL-hash duplicate. */
  | { status: 'duplicate'; urlHash: string }
  /** The Quality_Scorer rejected the item for scoring below the threshold. */
  | { status: 'rejected-quality'; qualityScore: number }
  /** Summarization was exhausted; the item is left unsummarized and not stored. */
  | { status: 'unsummarized'; attempts: number }
  /** Embedding was exhausted; storage is blocked and the item is not stored. */
  | { status: 'embedding-failed'; attempts: number }
  /** The completeness gate refused storage; lists the offending fields. */
  | { status: 'storage-rejected'; missingFields: CompletenessField[] };

/**
 * Run a single {@link RawContentItem} through the Ingestion_Pipeline stages in
 * the order required by Requirement 5.2 — Deduplicator → Quality_Scorer →
 * Summarizer → Embedder → Read_Time_Estimator → storage — short-circuiting at
 * the first stage that rejects the item:
 *
 * 1. **Deduplicator** — a URL-hash collision discards the item (Requirements
 *    6.1, 6.2) and returns `duplicate`.
 * 2. **Quality_Scorer** — a score `< 0.3` rejects the item (Requirements 6.3,
 *    6.4) and returns `rejected-quality`.
 * 3. **Summarizer** — exhausting the bounded retries leaves the item
 *    unsummarized (Requirements 7.3, 7.4) and returns `unsummarized` without
 *    storing.
 * 4. **Embedder** — exhausting the bounded retries blocks storage
 *    (Requirements 7.6, 7.7) and returns `embedding-failed`.
 * 5. **Read_Time_Estimator** — supplies a whole-minute read time when the
 *    Summarizer did not (Requirement 6.6).
 * 6. **storage** — the completeness gate persists and indexes a complete
 *    Article (Requirements 6.5, 7.5); a gate failure returns `storage-rejected`.
 *
 * The orchestrator never throws for these expected rejections; it returns a
 * discriminated {@link ProcessItemResult}. (Errors from the injected lookups
 * propagate to the caller, where {@link runIngestionForSources} isolates them
 * per source.)
 */
export async function processItem(
  item: RawContentItem,
  deps: ProcessItemDeps,
): Promise<ProcessItemResult> {
  // 1. Deduplicator — discard URL-hash duplicates (Requirements 6.1, 6.2).
  const deduplicator = new Deduplicator({
    lookup: deps.dedupLookup,
    recordRejectedDuplicate: deps.recordRejectedDuplicate,
  });
  const dedup = await deduplicator.evaluate(item.url);
  if (dedup.isDuplicate) {
    return { status: 'duplicate', urlHash: dedup.urlHash };
  }

  // 2. Quality_Scorer — reject and block storage below 0.3 (Requirements 6.3, 6.4).
  const wordCount = countWords(item.body);
  const readingGradeLevel = (deps.readingGradeLevel ?? defaultReadingGrade)(item);
  const qualityScore = scoreQuality({ source: item.source, wordCount, readingGradeLevel });
  if (!meetsQualityThreshold(qualityScore)) {
    return { status: 'rejected-quality', qualityScore };
  }

  // 3. Summarizer — bounded retries; skip storage on exhaustion (Requirements 7.1–7.4).
  const summary = await summarize(
    { title: item.title, fullText: item.body },
    {
      client: deps.summarizerClient,
      taxonomySlugs: deps.taxonomySlugs,
      maxAttempts: deps.maxSummarizerAttempts,
      defaultConfidence: deps.defaultTopicConfidence,
      onAttemptFailed: deps.onSummarizerAttemptFailed,
    },
  );
  if (summary.status === 'unsummarized') {
    return { status: 'unsummarized', attempts: summary.attempts };
  }

  // 4. Embedder — bounded retries; block storage on exhaustion (Requirements 7.5–7.7).
  const embedding = await embed(embeddingText(item), {
    client: deps.embeddingClient,
    logFailure: deps.logEmbeddingFailure,
  });
  if (embedding.status === 'failure') {
    return { status: 'embedding-failed', attempts: embedding.attempts };
  }

  // 5. Read_Time_Estimator — use the Summarizer's read time when it is a valid
  //    whole-minute value, otherwise compute one (Requirement 6.6: "WHERE an
  //    Article lacks an estimated read time, THE Read_Time_Estimator SHALL
  //    compute a read time...").
  const summaryReadTime = summary.output.readTimeMinutes;
  const readTimeMinutes =
    Number.isInteger(summaryReadTime) && summaryReadTime >= MIN_READ_TIME_MINUTES
      ? summaryReadTime
      : estimateReadTimeMinutes(wordCount, { wordsPerMinute: deps.wordsPerMinute });

  // 6. storage — completeness gate persists then indexes (Requirements 6.5, 7.5).
  const stored = await storeArticle(
    { repository: deps.repository, searchIndex: deps.searchIndex },
    {
      url: item.url,
      source: item.source,
      title: item.title,
      summary: summary.output.summary,
      fullText: item.body,
      qualityScore,
      embedding: embedding.embedding,
      readTimeMinutes,
    },
  );
  if (stored.status === 'rejected') {
    return { status: 'storage-rejected', missingFields: stored.missingFields };
  }
  return { status: 'stored', id: stored.id, readTimeMinutes, qualityScore };
}

/**
 * Error raised when a crawl does not complete within its time budget
 * (Requirement 5.6, the ">30s timeout" branch). Carries the affected source so
 * the orchestrator can identify it in the recorded `crawl_failure`.
 */
export class CrawlTimeoutError extends Error {
  /** The Source whose crawl timed out. */
  readonly source: Source;
  /** The timeout budget, in milliseconds, that was exceeded. */
  readonly timeoutMs: number;

  constructor(source: Source, timeoutMs: number) {
    super(`${source} crawl exceeded ${timeoutMs}ms timeout`);
    this.name = 'CrawlTimeoutError';
    this.source = source;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps an async operation with a timeout. Injected into
 * {@link runIngestionForSources} so the 30-second crawl budget can be enforced
 * deterministically in tests without real long-running timers.
 */
export type TimeoutWrapper = <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  source: Source,
) => Promise<T>;

/**
 * Default {@link TimeoutWrapper}: races `operation()` against a timer that
 * rejects with a {@link CrawlTimeoutError} after `timeoutMs`. The timer is
 * unref'd so it never keeps the process alive, and is cleared as soon as the
 * operation settles.
 */
export const withTimeout: TimeoutWrapper = (operation, timeoutMs, source) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CrawlTimeoutError(source, timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    operation().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      },
    );
  });

/**
 * Records an isolated crawl failure (the `crawl_failure` table, Requirements
 * 5.6, 5.7). Injected so the orchestrator can record failures without a
 * database dependency. May be synchronous or asynchronous; the orchestrator
 * awaits the result and tolerates a rejection (Requirement 5.7).
 */
export type CrawlFailureRecorder = (failure: {
  source: Source;
  error: string;
}) => void | Promise<void>;

/** One source's crawl job: the crawler plus the inputs to its crawl window. */
export interface SourceCrawlJob {
  /** The Crawler for this source. */
  crawler: Crawler;
  /**
   * The source's last successful crawl time (ISO-8601), or `null` to use the
   * 24-hour backfill window on the first run.
   */
  lastSuccessfulCrawlAt: string | null;
  /** The crawl cycle's "now", in epoch milliseconds. */
  nowMs: number;
}

/** Per-source outcome of an ingestion cycle. */
export type SourceOutcome =
  /** The source crawled successfully; `items` holds each item's pipeline result. */
  | {
      source: Source;
      status: 'crawled';
      window: CrawlWindow;
      advancedTo: string | null;
      items: ProcessItemResult[];
    }
  /**
   * The source's crawl failed (timeout or error response). The failure was
   * recorded (`failureRecorded: true`) unless recording itself threw, in which
   * case the cycle still continued (Requirement 5.7) and `recorderError` holds
   * the recorder's error message.
   */
  | {
      source: Source;
      status: 'failed';
      error: string;
      failureRecorded: boolean;
      recorderError?: string;
    };

/** Result of a full ingestion cycle across all supplied sources. */
export interface RunIngestionResult {
  /** One outcome per source, in the order the sources were supplied. */
  outcomes: SourceOutcome[];
}

/** Dependencies injected into {@link runIngestionForSources}. */
export interface RunIngestionDeps extends ProcessItemDeps {
  /** Records an isolated crawl failure identifying the source (Requirements 5.6, 5.7). */
  recordCrawlFailure: CrawlFailureRecorder;
  /** Optional crawl-state store; advances `last_successful_crawl_at` per source. */
  crawlStateStore?: CrawlStateStore;
  /** Optional timeout wrapper; defaults to {@link withTimeout}. */
  withTimeout?: TimeoutWrapper;
  /** Optional timeout budget in ms; defaults to {@link DEFAULT_CRAWL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Whether `crawlSince` should drop items outside the window. Defaults to true. */
  enforceWindow?: boolean;
}

/**
 * Crawl each source and process its items, isolating failures per source
 * (Requirements 5.2, 5.6, 5.7).
 *
 * For each {@link SourceCrawlJob} the orchestrator runs `crawlSince` inside the
 * injected {@link TimeoutWrapper} (a >30s timeout rejects with
 * {@link CrawlTimeoutError}), then runs every returned item through
 * {@link processItem} in sequence. If the crawl times out or the source returns
 * an error/non-2xx response — surfaced as a thrown {@link CrawlTimeoutError},
 * a `CrawlError`, or any other error — the orchestrator records a
 * `crawl_failure` identifying the source via {@link CrawlFailureRecorder} and
 * CONTINUES with the remaining sources (Requirement 5.6). If recording the
 * failure itself throws, the cycle still continues (Requirement 5.7). The
 * returned {@link RunIngestionResult} reports one outcome per source.
 */
export async function runIngestionForSources(
  sources: readonly SourceCrawlJob[],
  deps: RunIngestionDeps,
): Promise<RunIngestionResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CRAWL_TIMEOUT_MS;
  const timeoutWrapper = deps.withTimeout ?? withTimeout;
  const outcomes: SourceOutcome[] = [];

  for (const job of sources) {
    const source = job.crawler.source;
    try {
      // Crawl under the timeout budget (Requirement 5.6, ">30s timeout").
      const crawl = await timeoutWrapper(
        () =>
          crawlSince(job.crawler, job.lastSuccessfulCrawlAt, job.nowMs, {
            store: deps.crawlStateStore,
            enforceWindow: deps.enforceWindow,
          }),
        timeoutMs,
        source,
      );

      // Process each item through the pipeline in sequence (Requirement 5.2).
      const items: ProcessItemResult[] = [];
      for (const item of crawl.items) {
        items.push(await processItem(item, deps));
      }

      outcomes.push({
        source,
        status: 'crawled',
        window: crawl.window,
        advancedTo: crawl.advancedTo,
        items,
      });
    } catch (error) {
      // A timeout or error response: record a crawl_failure and continue
      // (Requirement 5.6). Recording is itself tolerant of failure: if it
      // throws, the cycle still continues (Requirement 5.7).
      const message = errorMessage(error);
      try {
        await deps.recordCrawlFailure({ source, error: message });
        outcomes.push({ source, status: 'failed', error: message, failureRecorded: true });
      } catch (recorderError) {
        outcomes.push({
          source,
          status: 'failed',
          error: message,
          failureRecorded: false,
          recorderError: errorMessage(recorderError),
        });
      }
    }
  }

  return { outcomes };
}

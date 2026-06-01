// Unit tests for the Ingestion_Pipeline orchestration (Requirements 5.2, 5.6, 5.7).
//
// These exercise the two orchestration entry points in `./pipeline.ts` with
// fakes for every external concern (dedup lookup, summarizer/embedder clients,
// repository + search index, crawl-failure recorder, and an injectable timeout
// wrapper) so no test touches the network, a database, or a real long timer.
//
// Coverage:
//   - processItem: a full happy-path item flows through all stages to storage
//     in the required order, and a duplicate / low-quality / embedding-exhausted
//     item is short-circuited and never stored (Requirement 5.2).
//   - runIngestionForSources: one source timing out or erroring records a
//     crawl_failure and the other sources still process (Requirement 5.6); and a
//     throwing failure-recorder does not abort the remaining sources
//     (Requirement 5.7).

import { describe, it, expect, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, type Source } from '@lumina/shared';
import {
  CrawlTimeoutError,
  processItem,
  runIngestionForSources,
  withTimeout,
  type CrawlFailureRecorder,
  type ProcessItemDeps,
  type RunIngestionDeps,
  type SourceCrawlJob,
} from './pipeline.js';
import { CrawlError, type Crawler, type CrawlWindow, type RawContentItem } from '../crawlers/types.js';
import type { ExistingHashLookup } from './dedup.js';
import type { SummarizerClient } from './summarizer.js';
import type { EmbeddingClient } from './embedder.js';
import type { ArticleSearchIndex, ArticleStore, CompleteArticleInput } from './storage-gate.js';

const TAXONOMY = ['physics', 'machine-learning', 'biology', 'history'] as const;

/** A valid, accepted summarizer payload whose tags are drawn from the taxonomy. */
const VALID_SUMMARY = {
  summary: 'First sentence here. Second sentence follows.',
  tags: ['physics'],
  difficulty: 'introductory' as const,
  readTimeMinutes: 7,
};

/** A valid 1536-dimension embedding of finite numbers. */
function validEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);
}

/** A long-enough body so the quality score clears the 0.3 threshold by default. */
function longBody(): string {
  return Array.from({ length: 600 }, (_unused, i) => `word${i}`).join(' ');
}

function rawItem(overrides: Partial<RawContentItem> = {}): RawContentItem {
  return {
    url: 'https://example.com/articles/quantum',
    title: 'Quantum Entanglement Explained',
    body: longBody(),
    publishedAt: '2024-06-01T09:00:00.000Z',
    source: 'quanta',
    ...overrides,
  };
}

/** A dedup lookup that reports the given hashes as already stored. */
function fakeDedupLookup(storedHashes: Iterable<string> = []): ExistingHashLookup {
  const set = new Set(storedHashes);
  return {
    async existsByHash(hash: string) {
      return set.has(hash);
    },
  };
}

/** A summarizer client that always returns a valid payload. */
function okSummarizerClient(): SummarizerClient {
  return { async summarize() {
    return VALID_SUMMARY;
  } };
}

/** An embedding client that always returns a valid vector. */
function okEmbeddingClient(): EmbeddingClient {
  return { async embed() {
    return validEmbedding();
  } };
}

/** An embedding client that always throws (drives the Embedder to exhaustion). */
function failingEmbeddingClient(): EmbeddingClient {
  return { async embed(): Promise<number[]> {
    throw new Error('embedding api down');
  } };
}

interface RecordingDeps {
  deps: ProcessItemDeps;
  repository: ArticleStore & { insertComplete: ReturnType<typeof vi.fn> };
  searchIndex: ArticleSearchIndex & { indexComplete: ReturnType<typeof vi.fn> };
}

/** Assemble a full happy-path ProcessItemDeps, overridable per test. */
function makeProcessDeps(overrides: Partial<ProcessItemDeps> = {}): RecordingDeps {
  const repository = {
    insertComplete: vi.fn(async (_a: CompleteArticleInput) => ({ id: 'art-1' })),
  };
  const searchIndex = {
    indexComplete: vi.fn(async (_a: CompleteArticleInput & { id: string }) => {}),
  };
  const deps: ProcessItemDeps = {
    dedupLookup: fakeDedupLookup(),
    summarizerClient: okSummarizerClient(),
    taxonomySlugs: TAXONOMY,
    embeddingClient: okEmbeddingClient(),
    logEmbeddingFailure: vi.fn(),
    repository,
    searchIndex,
    ...overrides,
  };
  return { deps, repository, searchIndex };
}

describe('processItem (Requirement 5.2 — staged pipeline)', () => {
  it('flows a full happy-path item through all stages to storage', async () => {
    const { deps, repository, searchIndex } = makeProcessDeps();
    const item = rawItem();

    const result = await processItem(item, deps);

    expect(result.status).toBe('stored');
    if (result.status === 'stored') {
      expect(result.id).toBe('art-1');
      // The Summarizer supplied a valid whole-minute read time, so it is used.
      expect(result.readTimeMinutes).toBe(VALID_SUMMARY.readTimeMinutes);
      expect(result.qualityScore).toBeGreaterThanOrEqual(0.3);
    }

    // Storage persisted then indexed exactly the assembled complete article.
    expect(repository.insertComplete).toHaveBeenCalledTimes(1);
    expect(searchIndex.indexComplete).toHaveBeenCalledTimes(1);
    const stored = repository.insertComplete.mock.calls[0]?.[0] as CompleteArticleInput;
    expect(stored).toMatchObject({
      url: item.url,
      source: item.source,
      title: item.title,
      summary: VALID_SUMMARY.summary,
      fullText: item.body,
      readTimeMinutes: VALID_SUMMARY.readTimeMinutes,
    });
    expect(stored.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('runs the stages in order: dedup → quality → summarize → embed → store', async () => {
    const order: string[] = [];
    const dedupLookup: ExistingHashLookup = {
      async existsByHash() {
        order.push('dedup');
        return false;
      },
    };
    const summarizerClient: SummarizerClient = {
      async summarize() {
        order.push('summarize');
        return VALID_SUMMARY;
      },
    };
    const embeddingClient: EmbeddingClient = {
      async embed() {
        order.push('embed');
        return validEmbedding();
      },
    };
    const { deps } = makeProcessDeps({ dedupLookup, summarizerClient, embeddingClient });
    deps.repository.insertComplete = vi.fn(async () => {
      order.push('store');
      return { id: 'art-1' };
    });

    await processItem(rawItem(), deps);

    expect(order).toEqual(['dedup', 'summarize', 'embed', 'store']);
  });

  it('discards a duplicate item without summarizing, embedding, or storing', async () => {
    const item = rawItem();
    // Pre-seed the lookup with this item's URL hash so it collides.
    const { urlHash } = await import('./dedup.js');
    const recordRejectedDuplicate = vi.fn();
    const summarizerClient = { summarize: vi.fn() };
    const embeddingClient = { embed: vi.fn() };
    const { deps, repository, searchIndex } = makeProcessDeps({
      dedupLookup: fakeDedupLookup([urlHash(item.url)]),
      recordRejectedDuplicate,
      summarizerClient: summarizerClient as unknown as SummarizerClient,
      embeddingClient: embeddingClient as unknown as EmbeddingClient,
    });

    const result = await processItem(item, deps);

    expect(result.status).toBe('duplicate');
    expect(recordRejectedDuplicate).toHaveBeenCalledTimes(1);
    expect(summarizerClient.summarize).not.toHaveBeenCalled();
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(repository.insertComplete).not.toHaveBeenCalled();
    expect(searchIndex.indexComplete).not.toHaveBeenCalled();
  });

  it('rejects a low-quality item and does not store it', async () => {
    const summarizerClient = { summarize: vi.fn() };
    const { deps, repository } = makeProcessDeps({
      summarizerClient: summarizerClient as unknown as SummarizerClient,
      // A short body on the lowest-tier source, pitched far outside the ideal
      // reading band, scores below the 0.3 threshold.
      readingGradeLevel: () => 30,
    });
    const result = await processItem(rawItem({ source: 'medium', body: 'too short' }), deps);

    expect(result.status).toBe('rejected-quality');
    if (result.status === 'rejected-quality') {
      expect(result.qualityScore).toBeLessThan(0.3);
    }
    expect(summarizerClient.summarize).not.toHaveBeenCalled();
    expect(repository.insertComplete).not.toHaveBeenCalled();
  });

  it('skips storage when embedding is exhausted', async () => {
    const logEmbeddingFailure = vi.fn();
    const { deps, repository, searchIndex } = makeProcessDeps({
      embeddingClient: failingEmbeddingClient(),
      logEmbeddingFailure,
    });

    const result = await processItem(rawItem(), deps);

    expect(result.status).toBe('embedding-failed');
    if (result.status === 'embedding-failed') {
      expect(result.attempts).toBe(3);
    }
    expect(logEmbeddingFailure).toHaveBeenCalledTimes(1);
    expect(repository.insertComplete).not.toHaveBeenCalled();
    expect(searchIndex.indexComplete).not.toHaveBeenCalled();
  });

  it('leaves an item unsummarized (and unstored) when summarization is exhausted', async () => {
    const embeddingClient = { embed: vi.fn() };
    const { deps, repository } = makeProcessDeps({
      summarizerClient: { async summarize() {
        return { not: 'valid' };
      } },
      embeddingClient: embeddingClient as unknown as EmbeddingClient,
    });

    const result = await processItem(rawItem(), deps);

    expect(result.status).toBe('unsummarized');
    if (result.status === 'unsummarized') {
      expect(result.attempts).toBe(3);
    }
    // Embedding and storage are never reached.
    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(repository.insertComplete).not.toHaveBeenCalled();
  });

  it('uses the summarizer-supplied whole-minute read time when present (Requirement 6.6)', async () => {
    const { deps } = makeProcessDeps({
      summarizerClient: { async summarize() {
        return { ...VALID_SUMMARY, readTimeMinutes: 3 };
      } },
      wordsPerMinute: 200,
    });

    const result = await processItem(rawItem({ body: longBody() }), deps);

    // The summarizer's valid read time (3) is used rather than a recomputed one.
    expect(result.status).toBe('stored');
    if (result.status === 'stored') {
      expect(result.readTimeMinutes).toBe(3);
    }
  });
});

// --- runIngestionForSources -------------------------------------------------

/** A crawler stub returning a fixed item list within any window. */
function stubCrawler(source: Source, items: RawContentItem[]): Crawler {
  return {
    source,
    async fetchItems(_window: CrawlWindow) {
      return items;
    },
  };
}

/** A crawler stub whose fetch rejects (an error / non-2xx response). */
function erroringCrawler(source: Source, error: Error): Crawler {
  return {
    source,
    fetchItems: vi.fn().mockRejectedValue(error),
  };
}

/** A crawler stub whose fetch never settles (simulates a hang to be timed out). */
function hangingCrawler(source: Source): Crawler {
  return {
    source,
    fetchItems: () => new Promise<RawContentItem[]>(() => {}),
  };
}

function job(crawler: Crawler, nowMs = Date.parse('2024-06-01T12:00:00.000Z')): SourceCrawlJob {
  return { crawler, lastSuccessfulCrawlAt: null, nowMs };
}

function makeRunDeps(
  recordCrawlFailure: CrawlFailureRecorder,
  overrides: Partial<RunIngestionDeps> = {},
): RunIngestionDeps {
  const { deps } = makeProcessDeps();
  return {
    ...deps,
    recordCrawlFailure,
    // A short, real timeout: healthy/erroring crawlers settle on a microtask
    // well inside it, while a genuinely hanging crawler is timed out
    // deterministically — no real long (30s) timer is used.
    withTimeout,
    timeoutMs: 50,
    enforceWindow: false,
    ...overrides,
  };
}

describe('runIngestionForSources (Requirements 5.6, 5.7 — per-source isolation)', () => {
  it('processes all items of a healthy source through the pipeline', async () => {
    const recordCrawlFailure = vi.fn();
    const crawler = stubCrawler('quanta', [rawItem(), rawItem({ url: 'https://example.com/b' })]);
    const deps = makeRunDeps(recordCrawlFailure);

    const result = await runIngestionForSources([job(crawler)], deps);

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    expect(outcome?.status).toBe('crawled');
    if (outcome?.status === 'crawled') {
      expect(outcome.items).toHaveLength(2);
      expect(outcome.items.every((r) => r.status === 'stored')).toBe(true);
    }
    expect(recordCrawlFailure).not.toHaveBeenCalled();
  });

  it('records a crawl_failure for an erroring source and still processes the others', async () => {
    const recordCrawlFailure = vi.fn(async () => {});
    const failing = erroringCrawler('hacker_news', new CrawlError('hacker_news', 'status 503'));
    const healthy = stubCrawler('quanta', [rawItem()]);
    const deps = makeRunDeps(recordCrawlFailure);

    const result = await runIngestionForSources([job(failing), job(healthy)], deps);

    // The failure was recorded for the failing source...
    expect(recordCrawlFailure).toHaveBeenCalledTimes(1);
    expect(recordCrawlFailure).toHaveBeenCalledWith({ source: 'hacker_news', error: 'status 503' });

    const [failedOutcome, healthyOutcome] = result.outcomes;
    expect(failedOutcome).toMatchObject({
      source: 'hacker_news',
      status: 'failed',
      failureRecorded: true,
    });
    // ...and the other source still processed its items (Requirement 5.6).
    expect(healthyOutcome?.status).toBe('crawled');
    if (healthyOutcome?.status === 'crawled') {
      expect(healthyOutcome.items).toHaveLength(1);
      expect(healthyOutcome.items[0]?.status).toBe('stored');
    }
  });

  it('records a crawl_failure for a source that times out (>30s) and continues', async () => {
    const recordCrawlFailure = vi.fn(async () => {});
    const hanging = hangingCrawler('arxiv');
    const healthy = stubCrawler('quanta', [rawItem()]);
    const deps = makeRunDeps(recordCrawlFailure);

    const result = await runIngestionForSources([job(hanging), job(healthy)], deps);

    expect(recordCrawlFailure).toHaveBeenCalledTimes(1);
    const recorded = recordCrawlFailure.mock.calls[0]?.[0];
    expect(recorded?.source).toBe('arxiv');
    expect(recorded?.error).toContain('timeout');

    expect(result.outcomes[0]).toMatchObject({ source: 'arxiv', status: 'failed' });
    expect(result.outcomes[1]?.status).toBe('crawled');
  });

  it('continues with remaining sources even when recording the failure throws (Requirement 5.7)', async () => {
    const recordCrawlFailure = vi.fn(async () => {
      throw new Error('crawl_failure insert failed');
    });
    const failing = erroringCrawler('mit_news', new Error('network reset'));
    const healthy = stubCrawler('quanta', [rawItem()]);
    const deps = makeRunDeps(recordCrawlFailure);

    const result = await runIngestionForSources([job(failing), job(healthy)], deps);

    expect(recordCrawlFailure).toHaveBeenCalledTimes(1);

    const failedOutcome = result.outcomes[0];
    expect(failedOutcome).toMatchObject({
      source: 'mit_news',
      status: 'failed',
      failureRecorded: false,
      recorderError: 'crawl_failure insert failed',
    });

    // The healthy source still processed despite the recorder throwing.
    const healthyOutcome = result.outcomes[1];
    expect(healthyOutcome?.status).toBe('crawled');
    if (healthyOutcome?.status === 'crawled') {
      expect(healthyOutcome.items[0]?.status).toBe('stored');
    }
  });

  it('isolates failures across many sources so one bad source never blocks others', async () => {
    const recordCrawlFailure = vi.fn(async () => {});
    const jobs = [
      job(erroringCrawler('wikipedia', new CrawlError('wikipedia', 'boom'))),
      job(stubCrawler('quanta', [rawItem()])),
      job(hangingCrawler('arxiv')),
      job(stubCrawler('mit_news', [rawItem({ url: 'https://example.com/m' })])),
    ];
    const deps = makeRunDeps(recordCrawlFailure);

    const result = await runIngestionForSources(jobs, deps);

    expect(result.outcomes.map((o) => o.status)).toEqual([
      'failed',
      'crawled',
      'failed',
      'crawled',
    ]);
    expect(recordCrawlFailure).toHaveBeenCalledTimes(2);
  });
});

describe('withTimeout (default wrapper)', () => {
  it('resolves with the operation result when it settles in time', async () => {
    const value = await withTimeout(async () => 'ok', 1000, 'quanta');
    expect(value).toBe('ok');
  });

  it('rejects with CrawlTimeoutError when the operation exceeds the budget', async () => {
    await expect(
      withTimeout(() => new Promise<string>(() => {}), 5, 'arxiv'),
    ).rejects.toBeInstanceOf(CrawlTimeoutError);
  });

  it('propagates the operation error when it rejects in time', async () => {
    await expect(
      withTimeout(async () => {
        throw new Error('boom');
      }, 1000, 'medium'),
    ).rejects.toThrow('boom');
  });
});

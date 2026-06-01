import { describe, it, expect } from 'vitest';
import { SOURCES, type Source } from '@lumina/shared';
import { QUEUE_NAMES } from '../index.js';
import {
  CRAWL_INTERVALS,
  FIFTEEN_MINUTES_MS,
  ONE_HOUR_MS,
  SIX_HOURS_MS,
} from './intervals.js';
import {
  crawlJobName,
  registerCrawlSchedules,
  PREFERENCE_JOB_NAME,
  registerPreferenceSchedule,
  type CrawlJobData,
  type PreferenceJobData,
  type PreferenceQueue,
  type RepeatableJobOptions,
  type RepeatableQueue,
} from './register.js';

// Unit tests for the Scheduler interval registration (Requirement 5.5):
// each of the six Sources is registered as a repeatable crawl job with its
// correct interval — Wikipedia hourly, Hacker News every 15 minutes, and
// Medium / arXiv / MIT News / Quanta every 6 hours — with exactly six jobs
// registered. A fake queue records every call, so no live Redis/BullMQ is
// touched.

interface RecordedCall {
  name: string;
  data: CrawlJobData;
  opts: RepeatableJobOptions;
}

/** A fake `RepeatableQueue` that records each `add` invocation. */
function fakeQueue(): RepeatableQueue & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async add(name: string, data: CrawlJobData, opts: RepeatableJobOptions): Promise<unknown> {
      calls.push({ name, data, opts });
      return undefined;
    },
  };
}

describe('registerCrawlSchedules', () => {
  it('registers exactly six repeatable jobs — one per Source', async () => {
    const queue = fakeQueue();

    await registerCrawlSchedules(queue);

    expect(queue.calls).toHaveLength(6);
    const sources = queue.calls.map((c) => c.data.source).sort();
    expect(sources).toEqual([...SOURCES].sort());
  });

  it('registers each Source with its correct crawl interval', async () => {
    const queue = fakeQueue();

    await registerCrawlSchedules(queue);

    const intervalBySource = new Map<Source, number>(
      queue.calls.map((c) => [c.data.source, c.opts.repeat.every]),
    );

    expect(intervalBySource.get('wikipedia')).toBe(ONE_HOUR_MS);
    expect(intervalBySource.get('hacker_news')).toBe(FIFTEEN_MINUTES_MS);
    expect(intervalBySource.get('medium')).toBe(SIX_HOURS_MS);
    expect(intervalBySource.get('arxiv')).toBe(SIX_HOURS_MS);
    expect(intervalBySource.get('mit_news')).toBe(SIX_HOURS_MS);
    expect(intervalBySource.get('quanta')).toBe(SIX_HOURS_MS);
  });

  it('uses each Source interval from CRAWL_INTERVALS as the single source of truth', async () => {
    const queue = fakeQueue();

    await registerCrawlSchedules(queue);

    for (const call of queue.calls) {
      expect(call.opts.repeat.every).toBe(CRAWL_INTERVALS[call.data.source]);
    }
  });

  it('names each job per Source and keys jobId for upsert-on-reregister', async () => {
    const queue = fakeQueue();

    await registerCrawlSchedules(queue);

    for (const source of SOURCES) {
      const call = queue.calls.find((c) => c.data.source === source);
      expect(call).toBeDefined();
      expect(call?.name).toBe(crawlJobName(source));
      expect(call?.opts.jobId).toBe(crawlJobName(source));
    }
  });

  it('returns the crawl queue name', async () => {
    const queue = fakeQueue();

    const queueName = await registerCrawlSchedules(queue);

    expect(queueName).toBe(QUEUE_NAMES.crawl);
  });
});

describe('CRAWL_INTERVALS', () => {
  it('matches the Requirement 5.5 cadences', () => {
    expect(CRAWL_INTERVALS.wikipedia).toBe(3_600_000);
    expect(CRAWL_INTERVALS.hacker_news).toBe(900_000);
    expect(CRAWL_INTERVALS.medium).toBe(21_600_000);
    expect(CRAWL_INTERVALS.arxiv).toBe(21_600_000);
    expect(CRAWL_INTERVALS.mit_news).toBe(21_600_000);
    expect(CRAWL_INTERVALS.quanta).toBe(21_600_000);
  });
});

describe('registerPreferenceSchedule (Req 14.1)', () => {
  interface RecordedPref {
    name: string;
    data: PreferenceJobData;
    opts: RepeatableJobOptions;
  }
  function fakePreferenceQueue(): PreferenceQueue & { readonly calls: RecordedPref[] } {
    const calls: RecordedPref[] = [];
    return {
      calls,
      async add(name: string, data: PreferenceJobData, opts: RepeatableJobOptions) {
        calls.push({ name, data, opts });
        return undefined;
      },
    };
  }

  it('registers exactly one repeatable job firing every 6 hours', async () => {
    const queue = fakePreferenceQueue();

    await registerPreferenceSchedule(queue);

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0].opts.repeat.every).toBe(SIX_HOURS_MS);
  });

  it('names the job and keys jobId for upsert-on-reregister', async () => {
    const queue = fakePreferenceQueue();

    await registerPreferenceSchedule(queue);

    expect(queue.calls[0].name).toBe(PREFERENCE_JOB_NAME);
    expect(queue.calls[0].opts.jobId).toBe(PREFERENCE_JOB_NAME);
  });

  it('returns the preference-model queue name', async () => {
    const queue = fakePreferenceQueue();

    const queueName = await registerPreferenceSchedule(queue);

    expect(queueName).toBe(QUEUE_NAMES.preferenceModel);
  });
});

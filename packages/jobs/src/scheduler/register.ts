// Crawl schedule registration (Requirement 5.5).
//
// `registerCrawlSchedules` registers one BullMQ repeatable job per Source on
// the crawl queue, each with its per-source interval from `CRAWL_INTERVALS`.
// The queue is abstracted behind the narrow `RepeatableQueue` interface so the
// registration can be unit-tested with a fake queue — no live Redis/BullMQ is
// required. A real BullMQ `Queue` satisfies this interface via its `add`
// method (`add(name, data, { repeat: { every } })`).

import { SOURCES, type Source } from '@lumina/shared';
import { QUEUE_NAMES, type QueueName } from '../index.js';
import { CRAWL_INTERVALS, SIX_HOURS_MS } from './intervals.js';

/** The job-name prefix used for each per-source repeatable crawl job. */
export const CRAWL_JOB_PREFIX = 'crawl';

/** The payload attached to each repeatable crawl job. */
export interface CrawlJobData {
  /** The Source this repeatable job crawls. */
  source: Source;
}

/** Options accepted when adding a repeatable job. Mirrors BullMQ's `JobsOptions`. */
export interface RepeatableJobOptions {
  /** Repeat configuration: fire the job every `every` milliseconds. */
  repeat: { every: number };
  /**
   * Stable identifier so re-registration updates (rather than duplicates) the
   * repeatable job. Mirrors BullMQ's `jobId`.
   */
  jobId?: string;
}

/**
 * The narrow slice of a queue that {@link registerCrawlSchedules} depends on. A
 * BullMQ `Queue<CrawlJobData>` satisfies this directly through its `add`
 * method, while tests can supply a fake that records each call.
 */
export interface RepeatableQueue {
  /** Add (or upsert, via `opts.jobId`) a repeatable job to the queue. */
  add(name: string, data: CrawlJobData, opts: RepeatableJobOptions): Promise<unknown>;
}

/** The job name for a Source's repeatable crawl (e.g. `crawl:wikipedia`). */
export function crawlJobName(source: Source): string {
  return `${CRAWL_JOB_PREFIX}:${source}`;
}

/**
 * Register one repeatable crawl job per Source on the supplied queue, each
 * firing at its {@link CRAWL_INTERVALS} cadence (Requirement 5.5). Exactly six
 * jobs are registered — one for every {@link SOURCES} entry — onto the
 * `QUEUE_NAMES.crawl` queue. The `jobId` is keyed by Source so repeated
 * registration upserts rather than duplicates a Source's schedule.
 *
 * @param queue The crawl queue (or a test fake) implementing {@link RepeatableQueue}.
 * @returns The {@link QueueName} the jobs were registered against.
 */
export async function registerCrawlSchedules(queue: RepeatableQueue): Promise<QueueName> {
  await Promise.all(
    SOURCES.map((source) =>
      queue.add(
        crawlJobName(source),
        { source },
        { repeat: { every: CRAWL_INTERVALS[source] }, jobId: crawlJobName(source) },
      ),
    ),
  );
  return QUEUE_NAMES.crawl;
}

/** The repeatable-job name for the Preference_Model_Updater. */
export const PREFERENCE_JOB_NAME = 'preference-model:update';

/** The payload attached to the repeatable Preference_Model_Updater job (none required). */
export type PreferenceJobData = Record<string, never>;

/** The narrow slice of a queue {@link registerPreferenceSchedule} depends on. */
export interface PreferenceQueue {
  /** Add (or upsert, via `opts.jobId`) the repeatable preference job. */
  add(
    name: string,
    data: PreferenceJobData,
    opts: RepeatableJobOptions,
  ): Promise<unknown>;
}

/**
 * Register the Preference_Model_Updater as a single repeatable job firing every
 * 6 hours (Requirement 14.1) on the `QUEUE_NAMES.preferenceModel` queue. The
 * `jobId` is stable so repeated registration upserts rather than duplicates the
 * schedule.
 *
 * @param queue The preference-model queue (or a test fake).
 * @returns The {@link QueueName} the job was registered against.
 */
export async function registerPreferenceSchedule(queue: PreferenceQueue): Promise<QueueName> {
  await queue.add(
    PREFERENCE_JOB_NAME,
    {},
    { repeat: { every: SIX_HOURS_MS }, jobId: PREFERENCE_JOB_NAME },
  );
  return QUEUE_NAMES.preferenceModel;
}

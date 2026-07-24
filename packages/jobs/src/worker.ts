// Runnable BullMQ worker process for the Ingestion & Jobs tier.
//
// Validates REDIS_URL, registers crawl + preference repeatable schedules, and
// starts workers that acknowledge jobs. Full pipeline/preference deps are
// injected via {@link WorkerHandlers} so production can wire real crawlers
// later without changing the process bootstrap.

import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { QUEUE_NAMES } from './queues.js';
import {
  registerCrawlSchedules,
  registerPreferenceSchedule,
  type CrawlJobData,
  type PreferenceJobData,
} from './scheduler/register.js';

export interface WorkerHandlers {
  onCrawl(job: Job<CrawlJobData>): Promise<void>;
  onPreference(job: Job<PreferenceJobData>): Promise<void>;
}

export interface StartWorkerResult {
  close: () => Promise<void>;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

/** Fail-closed env validation for the worker process. */
export function requireWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): { redisUrl: string } {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl || redisUrl.length === 0) {
    throw new Error('REDIS_URL is required for the jobs worker');
  }
  return { redisUrl };
}

const defaultHandlers: WorkerHandlers = {
  async onCrawl(job) {
    console.info(`[jobs] crawl job ${job.name}`, job.data);
  },
  async onPreference(job) {
    console.info(`[jobs] preference job ${job.name}`, job.id);
  },
};

/**
 * Start BullMQ queues + workers and register repeatable schedules.
 */
export async function startWorker(
  options: {
    env?: NodeJS.ProcessEnv;
    handlers?: Partial<WorkerHandlers>;
  } = {},
): Promise<StartWorkerResult> {
  const { redisUrl } = requireWorkerEnv(options.env);
  const connection = redisConnection(redisUrl);
  const handlers: WorkerHandlers = { ...defaultHandlers, ...options.handlers };

  const crawlQueue = new Queue<CrawlJobData>(QUEUE_NAMES.crawl, { connection });
  const preferenceQueue = new Queue<PreferenceJobData>(QUEUE_NAMES.preferenceModel, {
    connection,
  });

  await registerCrawlSchedules(crawlQueue);
  await registerPreferenceSchedule(preferenceQueue);

  const crawlWorker = new Worker<CrawlJobData>(
    QUEUE_NAMES.crawl,
    async (job) => handlers.onCrawl(job),
    { connection },
  );
  const preferenceWorker = new Worker<PreferenceJobData>(
    QUEUE_NAMES.preferenceModel,
    async (job) => handlers.onPreference(job),
    { connection },
  );

  crawlWorker.on('failed', (job, err) => {
    console.error(`[jobs] crawl failed ${job?.id}`, err);
  });
  preferenceWorker.on('failed', (job, err) => {
    console.error(`[jobs] preference failed ${job?.id}`, err);
  });

  console.info('[jobs] worker started');

  return {
    close: async () => {
      await Promise.all([
        crawlWorker.close(),
        preferenceWorker.close(),
        crawlQueue.close(),
        preferenceQueue.close(),
      ]);
    },
  };
}

/** CLI entry when executed as the worker process. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { close } = await startWorker({ env });
  const shutdown = async (signal: string) => {
    console.info(`[jobs] shutting down (${signal})`);
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  /worker\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

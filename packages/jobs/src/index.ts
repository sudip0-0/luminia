// @lumina/jobs — Ingestion & Jobs tier.
//
// Houses the Scheduler-driven Ingestion_Pipeline (Crawler, Deduplicator,
// Quality_Scorer, Summarizer, Embedder, Read_Time_Estimator) and the
// Preference_Model_Updater. The runnable BullMQ process lives in `worker.ts`.

export const JOBS_PACKAGE_NAME = '@lumina/jobs';

export { QUEUE_NAMES, type QueueName } from './queues.js';

// Ingestion_Pipeline components.
export {
  Deduplicator,
  normalizeUrl,
  urlHash,
  type DeduplicatorOptions,
  type DedupResult,
  type DuplicateRecorder,
  type ExistingHashLookup,
  type RejectedDuplicate,
} from './ingestion/dedup.js';

export {
  registerCrawlSchedules,
  registerPreferenceSchedule,
  type CrawlJobData,
  type PreferenceJobData,
} from './scheduler/register.js';

export { requireWorkerEnv, startWorker, main as startWorkerMain } from './worker.js';

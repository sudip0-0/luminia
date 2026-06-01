// @lumina/jobs — Ingestion & Jobs tier.
//
// Houses the Scheduler-driven Ingestion_Pipeline (Crawler, Deduplicator,
// Quality_Scorer, Summarizer, Embedder, Read_Time_Estimator) and the
// Preference_Model_Updater. Per-source crawl intervals and the 6-hour
// preference job run as BullMQ repeatable jobs (added in later tasks).

export const JOBS_PACKAGE_NAME = '@lumina/jobs';

/** Logical queue names for the Ingestion & Jobs tier. */
export const QUEUE_NAMES = {
  crawl: 'lumina:crawl',
  ingestion: 'lumina:ingestion',
  preferenceModel: 'lumina:preference-model',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

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

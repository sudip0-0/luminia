/** Logical queue names for the Ingestion & Jobs tier. */
export const QUEUE_NAMES = {
  crawl: 'lumina:crawl',
  ingestion: 'lumina:ingestion',
  preferenceModel: 'lumina:preference-model',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

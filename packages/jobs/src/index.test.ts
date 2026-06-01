import { describe, it, expect } from 'vitest';
import { JOBS_PACKAGE_NAME, QUEUE_NAMES } from './index.js';

describe('@lumina/jobs', () => {
  it('exposes the package name', () => {
    expect(JOBS_PACKAGE_NAME).toBe('@lumina/jobs');
  });

  it('defines the queue names', () => {
    expect(QUEUE_NAMES.crawl).toBe('lumina:crawl');
    expect(QUEUE_NAMES.ingestion).toBe('lumina:ingestion');
    expect(QUEUE_NAMES.preferenceModel).toBe('lumina:preference-model');
  });
});

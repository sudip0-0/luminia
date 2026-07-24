import { describe, expect, it } from 'vitest';
import { requireWorkerEnv } from './worker.js';

describe('requireWorkerEnv', () => {
  it('throws when REDIS_URL is missing', () => {
    expect(() => requireWorkerEnv({})).toThrow(/REDIS_URL/);
  });

  it('returns the redis url when set', () => {
    expect(requireWorkerEnv({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      redisUrl: 'redis://localhost:6379',
    });
  });
});

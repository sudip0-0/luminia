import { describe, expect, it } from 'vitest';
import { checkReadiness } from './ready.js';
import { FakeQueryable } from './repositories/fake-queryable.js';

describe('checkReadiness', () => {
  it('reports ok when postgres and redis succeed', async () => {
    const result = await checkReadiness({
      db: new FakeQueryable(() => ({ rows: [{ '?column?': 1 }] })),
      redis: { ping: async () => 'PONG' },
    });
    expect(result.ok).toBe(true);
    expect(result.checks.postgres).toBe(true);
    expect(result.checks.redis).toBe(true);
    expect(result.checks.typesense).toBe('skipped');
  });

  it('reports not_ready when postgres fails', async () => {
    const result = await checkReadiness({
      db: new FakeQueryable(() => {
        throw new Error('down');
      }),
      redis: { ping: async () => 'PONG' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_ready');
    expect(result.checks.postgres).toBe(false);
  });

  it('includes typesense when configured', async () => {
    const result = await checkReadiness({
      db: new FakeQueryable(() => ({ rows: [{ '?column?': 1 }] })),
      redis: { ping: async () => 'PONG' },
      typesense: { healthy: async () => false },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.typesense).toBe(false);
  });
});

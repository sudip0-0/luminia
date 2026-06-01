import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FEED_EVENT_TYPES, type FeedEventInput } from '@lumina/shared';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { ingestBatch, MAX_BATCH_SIZE } from './ingest.js';

// Property-based tests for Feed_Event_Service batch ingestion (Requirement 13).

const USER = 'u-1';

/** FakeQueryable simulating the existence check + ON CONFLICT insert. */
function makeDb(opts: { existing?: string[] } = {}): FakeQueryable {
  const existing = new Set(opts.existing ?? []);
  return new FakeQueryable((sql, params): CannedResult => {
    if (sql.includes('INSERT INTO feed_event')) {
      const rows: Record<string, unknown>[] = [];
      for (let i = 1; i + 5 < params.length; i += 6) {
        rows.push({
          id: `fe-${String(params[i])}`,
          client_event_id: params[i],
          user_id: params[0],
          article_id: params[i + 1] ?? null,
          topic_id: params[i + 2] ?? null,
          type: params[i + 3],
          payload: {},
          occurred_at: new Date(params[i + 5] as string),
          created_at: new Date('2024-03-01T00:00:05.000Z'),
        });
      }
      return { rows };
    }
    if (sql.includes('SELECT client_event_id')) {
      const ids = params.slice(1) as string[];
      return { rows: ids.filter((id) => existing.has(id)).map((id) => ({ client_event_id: id })) };
    }
    return { rows: [] };
  });
}

function evt(clientEventId: string, type: string): FeedEventInput {
  return {
    clientEventId,
    type: type as FeedEventInput['type'],
    articleId: 'art-1',
    payload: {},
    occurredAt: '2024-03-01T00:00:00.000Z',
  };
}

describe('ingestBatch — Property 28 (over-limit atomic rejection, Req 13.5)', () => {
  it('rejects atomically iff the batch exceeds 500, persisting nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 600 }), async (n) => {
        const db = makeDb();
        const events = Array.from({ length: n }, (_, i) => evt(`ce-${i}`, 'impression'));
        const result = await ingestBatch({ db }, USER, { events });
        if (n > MAX_BATCH_SIZE) {
          expect(result.status).toBe('error');
          expect(db.calls).toHaveLength(0); // nothing processed
        } else {
          expect(result.status).toBe('ok');
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('ingestBatch — Property 27 (partial validation accounting, Req 13.1-13.3)', () => {
  it('persists valid events, rejects invalid ones, and reconciles to the batch size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.integer({ min: 0, max: 9999 }).map((n) => `ce-${n}`),
            valid: fc.boolean(),
          }),
          { selector: (e) => e.id, minLength: 0, maxLength: 60 },
        ),
        async (specs) => {
          const db = makeDb();
          const events = specs.map((s) => evt(s.id, s.valid ? 'impression' : 'totally-bogus'));
          const result = await ingestBatch({ db }, USER, { events });
          expect(result.status).toBe('ok');
          if (result.status !== 'ok') return;
          const { persisted, rejected, duplicates } = result.ack;
          // (13.3) buckets partition the submitted batch exactly.
          expect(persisted + rejected.length + duplicates).toBe(events.length);
          // distinct ids, none pre-existing => no duplicates.
          expect(duplicates).toBe(0);
          // (13.1/13.2) exactly the invalid-typed events are rejected.
          expect(rejected.length).toBe(specs.filter((s) => !s.valid).length);
          expect(persisted).toBe(specs.filter((s) => s.valid).length);
        },
      ),
    );
  });
});

describe('ingestBatch — Property 26 (idempotent on clientEventId, Req 13.4)', () => {
  it('never persists a pre-existing or within-batch-repeated clientEventId twice', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 999 }).map((n) => `ce-${n}`), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
        async (ids, preexistFlags) => {
          const existing = ids.filter((_, i) => preexistFlags[i % preexistFlags.length]);
          const db = makeDb({ existing });
          // Submit each valid event twice to force within-batch repeats too.
          const events = [...ids, ...ids].map((id) => evt(id, 'save'));
          const result = await ingestBatch({ db }, USER, { events });
          expect(result.status).toBe('ok');
          if (result.status !== 'ok') return;
          const { persisted, rejected, duplicates } = result.ack;
          expect(rejected.length).toBe(0);
          expect(persisted + duplicates).toBe(events.length);
          // Persisted = distinct ids that were NOT pre-existing; the rest are dups.
          const expectedPersisted = ids.filter((id) => !existing.includes(id)).length;
          expect(persisted).toBe(expectedPersisted);
        },
      ),
    );
  });
});

// Sanity: the valid event types the property relies on are real.
describe('FEED_EVENT_TYPES', () => {
  it('includes impression and save', () => {
    expect(FEED_EVENT_TYPES).toContain('impression');
    expect(FEED_EVENT_TYPES).toContain('save');
  });
});

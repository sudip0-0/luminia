import { describe, it, expect } from 'vitest';
import type { FeedEventInput } from '@lumina/shared';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { ingestBatch, MAX_BATCH_SIZE } from './ingest.js';

// Verifies the Feed_Event_Service batch ingestion (Requirement 13):
//   - atomic over-500 rejection (13.5)
//   - per-event type/field validation with partial persistence (13.1, 13.2)
//   - clientEventId de-duplication, within-batch and pre-existing (13.4)
//   - acknowledgement counts reconcile to the submitted batch size (13.3)

const USER = 'u-1';

function evt(overrides: Partial<FeedEventInput> & { clientEventId: string }): FeedEventInput {
  return {
    type: 'impression',
    articleId: 'art-1',
    payload: {},
    occurredAt: '2024-03-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A FakeQueryable that simulates the two repository queries the service issues:
 *   - the `SELECT client_event_id … IN (…)` existence check returns the ids in
 *     `existing` (Requirement 13.4 pre-existing duplicates), and
 *   - the `INSERT … ON CONFLICT DO NOTHING RETURNING …` returns a row for each
 *     submitted event whose id is NOT in `conflictOnInsert`, simulating the DB
 *     declining to re-insert a concurrently-stored id.
 */
function makeDb(opts: { existing?: string[]; conflictOnInsert?: string[] } = {}): FakeQueryable {
  const existing = new Set(opts.existing ?? []);
  const conflict = new Set(opts.conflictOnInsert ?? []);
  return new FakeQueryable((sql, params): CannedResult => {
    if (sql.includes('INSERT INTO feed_event')) {
      const rows: Record<string, unknown>[] = [];
      // params: [userId, (clientEventId, articleId, topicId, type, payload, occurredAt) * n]
      for (let i = 1; i + 5 < params.length; i += 6) {
        const clientEventId = params[i] as string;
        if (conflict.has(clientEventId)) continue;
        rows.push({
          id: `fe-${clientEventId}`,
          client_event_id: clientEventId,
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
      return {
        rows: ids.filter((id) => existing.has(id)).map((id) => ({ client_event_id: id })),
      };
    }
    return { rows: [] };
  });
}

/** Assert the acknowledgement buckets partition the submitted batch exactly. */
function expectReconciles(
  ack: { persisted: number; rejected: { length: number }; duplicates: number },
  submitted: number,
): void {
  expect(ack.persisted + ack.rejected.length + ack.duplicates).toBe(submitted);
}

describe('ingestBatch — over-limit atomic rejection (Req 13.5)', () => {
  it('rejects the entire batch and persists nothing when over 500 events', async () => {
    const db = makeDb();
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) =>
      evt({ clientEventId: `ce-${i}` }),
    );

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.error.message).toContain('exceeds the maximum');
    // Nothing was processed: no DB query was issued at all.
    expect(db.calls).toHaveLength(0);
  });

  it('accepts a batch exactly at the 500-event limit', async () => {
    const db = makeDb();
    const events = Array.from({ length: MAX_BATCH_SIZE }, (_, i) =>
      evt({ clientEventId: `ce-${i}` }),
    );

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(MAX_BATCH_SIZE);
    expectReconciles(result.ack, MAX_BATCH_SIZE);
  });
});

describe('ingestBatch — partial validation (Req 13.1, 13.2, 13.3)', () => {
  it('persists valid events, rejects invalid types, and reconciles counts', async () => {
    const db = makeDb();
    const events: FeedEventInput[] = [
      evt({ clientEventId: 'ce-1', type: 'save' }),
      // invalid type, cast through unknown since FeedEventInput.type is typed
      evt({ clientEventId: 'ce-2', type: 'bogus' as unknown as FeedEventInput['type'] }),
      evt({ clientEventId: 'ce-3', type: 'mute_topic' }),
      evt({ clientEventId: 'ce-4', type: '' as unknown as FeedEventInput['type'] }),
    ];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(2);
    expect(result.ack.duplicates).toBe(0);
    expect(result.ack.rejected).toHaveLength(2);
    expect(result.ack.rejected.map((r) => r.clientEventId).sort()).toEqual(['ce-2', 'ce-4']);
    // each rejection identifies the event and carries a reason (13.2)
    for (const r of result.ack.rejected) {
      expect(r.reason).toBeTruthy();
    }
    expectReconciles(result.ack, events.length);
  });

  it('rejects events with missing/invalid required fields (Req 13.1)', async () => {
    const db = makeDb();
    const events: FeedEventInput[] = [
      evt({ clientEventId: 'ce-1' }),
      // missing clientEventId (needed for idempotency)
      evt({ clientEventId: '' }),
      // unparseable occurredAt
      evt({ clientEventId: 'ce-3', occurredAt: 'not-a-date' }),
    ];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(1);
    expect(result.ack.rejected).toHaveLength(2);
    expectReconciles(result.ack, events.length);
  });
});

describe('ingestBatch — de-duplication (Req 13.4)', () => {
  it('counts pre-existing clientEventIds as duplicates and does not re-persist them', async () => {
    const db = makeDb({ existing: ['ce-1', 'ce-3'] });
    const events = [
      evt({ clientEventId: 'ce-1' }),
      evt({ clientEventId: 'ce-2' }),
      evt({ clientEventId: 'ce-3' }),
    ];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(1);
    expect(result.ack.duplicates).toBe(2);
    expect(result.ack.rejected).toHaveLength(0);
    expectReconciles(result.ack, events.length);
  });

  it('collapses repeats within the same batch, persisting one and counting the rest as duplicates', async () => {
    const db = makeDb();
    const events = [
      evt({ clientEventId: 'ce-dup' }),
      evt({ clientEventId: 'ce-dup' }),
      evt({ clientEventId: 'ce-dup' }),
      evt({ clientEventId: 'ce-other' }),
    ];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(2);
    expect(result.ack.duplicates).toBe(2);
    expectReconciles(result.ack, events.length);
  });

  it('counts an ON CONFLICT race (DB declines to insert) as a duplicate, keeping accounting exact', async () => {
    // ce-2 passes validation and the pre-existence check but the DB declines to
    // insert it (a concurrent writer stored it first) -> counted as a duplicate.
    const db = makeDb({ conflictOnInsert: ['ce-2'] });
    const events = [evt({ clientEventId: 'ce-1' }), evt({ clientEventId: 'ce-2' })];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(1);
    expect(result.ack.duplicates).toBe(1);
    expectReconciles(result.ack, events.length);
  });
});

describe('ingestBatch — combined accounting (Req 13.3)', () => {
  it('reconciles persisted + rejected + duplicates across a mixed batch', async () => {
    const db = makeDb({ existing: ['ce-existing'] });
    const events: FeedEventInput[] = [
      evt({ clientEventId: 'ce-existing' }), // pre-existing -> duplicate
      evt({ clientEventId: 'ce-new-1' }), // persisted
      evt({ clientEventId: 'ce-new-2' }), // persisted
      evt({ clientEventId: 'ce-new-2' }), // within-batch repeat -> duplicate
      evt({ clientEventId: 'ce-bad', type: 'nope' as unknown as FeedEventInput['type'] }), // rejected
    ];

    const result = await ingestBatch({ db }, USER, { events });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack.persisted).toBe(2);
    expect(result.ack.duplicates).toBe(2);
    expect(result.ack.rejected).toHaveLength(1);
    expectReconciles(result.ack, events.length);
  });

  it('handles an empty batch as a no-op acknowledgement', async () => {
    const db = makeDb();
    const result = await ingestBatch({ db }, USER, { events: [] });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.ack).toEqual({ persisted: 0, rejected: [], duplicates: 0 });
    // No candidates -> the repository issues no queries.
    expect(db.calls).toHaveLength(0);
  });
});

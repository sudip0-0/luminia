import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { FakeQueryable } from '../repositories/fake-queryable.js';
import {
  getEmergingInterests,
  acceptEmergingInterest,
  getFeedEvolutionNarrative,
} from './emerging.js';

// Tests for the Insights_Service emerging interests, acceptance, and narrative
// (Requirements 24.4, 24.5, 24.6, 24.7, 24.9, 24.10), including:
//   Property 49 — emerging interests are capped and exclude already-added topics
//   Property 50 — accepting an emerging topic transitions it into the user's topics
//   Property 51 — the feed-evolution narrative is bounded to 1-3 sentences

const NOW = Date.parse('2025-06-01T00:00:00.000Z');

function emergingRow(topicId: string, detectedAt = '2025-05-20T00:00:00.000Z') {
  return { user_id: 'u-1', topic_id: topicId, detected_at: detectedAt };
}
function userTopicRow(topicId: string) {
  return {
    user_id: 'u-1',
    topic_id: topicId,
    weight: 1,
    source: 'onboarding',
    muted: false,
    created_at: '2025-01-01T00:00:00.000Z',
  };
}
function dwellEventRow() {
  return {
    id: 'e-1',
    client_event_id: 'c-1',
    user_id: 'u-1',
    article_id: 'a-1',
    topic_id: null,
    type: 'dwell',
    payload: { dwellMs: 5000 },
    occurred_at: '2025-05-30T00:00:00.000Z',
    created_at: '2025-05-30T00:00:00.000Z',
  };
}

/** Responder routing by SQL target table. */
function responder(opts: {
  emerging?: unknown[];
  userTopics?: unknown[];
  dwellEvents?: unknown[];
  findEmerging?: unknown[];
}) {
  return (sql: string) => {
    if (/from emerging_topic/i.test(sql) && /where user_id = \$1\s+and topic_id/i.test(sql)) {
      return { rows: opts.findEmerging ?? [] };
    }
    if (/from emerging_topic/i.test(sql)) return { rows: opts.emerging ?? [] };
    if (/from user_topic/i.test(sql)) return { rows: opts.userTopics ?? [] };
    if (/from feed_event/i.test(sql)) return { rows: opts.dwellEvents ?? [] };
    // INSERT/DELETE ... RETURNING
    if (/insert into user_topic/i.test(sql)) return { rows: [userTopicRow('t-x')] };
    if (/delete from emerging_topic/i.test(sql)) return { rows: [emergingRow('t-x')] };
    return { rows: [] };
  };
}

describe('getEmergingInterests (Req 24.4, 24.9) — Property 49', () => {
  it('returns an empty list when none are detected', async () => {
    const db = new FakeQueryable(responder({ emerging: [], userTopics: [] }));
    expect(await getEmergingInterests({ db }, 'u-1')).toEqual([]);
  });

  it('caps at 3 and excludes already-added topics', async () => {
    fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 12 }),
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 6 }),
        async (emergingIds, addedIds) => {
          const db = new FakeQueryable(
            responder({
              emerging: emergingIds.map((id) => emergingRow(id)),
              userTopics: addedIds.map((id) => userTopicRow(id)),
            }),
          );
          const result = await getEmergingInterests({ db }, 'u-1');
          const added = new Set(addedIds);
          expect(result.length).toBeLessThanOrEqual(3);
          for (const r of result) expect(added.has(r.topicId)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('acceptEmergingInterest (Req 24.5, 24.6) — Property 50', () => {
  it('errors and changes nothing when the topic is not in the emerging list', async () => {
    const calls: string[] = [];
    const db = new FakeQueryable((sql) => {
      calls.push(sql);
      return responder({ findEmerging: [] })(sql);
    });
    const result = await acceptEmergingInterest({ db }, 'u-1', 't-missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe('NOT_FOUND');
    // No mutation occurred.
    expect(calls.some((s) => /insert into user_topic/i.test(s))).toBe(false);
    expect(calls.some((s) => /delete from emerging_topic/i.test(s))).toBe(false);
  });

  it('adds with source=inferred and removes from the emerging list when present', async () => {
    const calls: string[] = [];
    const db = new FakeQueryable((sql) => {
      calls.push(sql);
      return responder({ findEmerging: [emergingRow('t-x')] })(sql);
    });
    const result = await acceptEmergingInterest({ db }, 'u-1', 't-x');
    expect(result.ok).toBe(true);
    expect(calls.some((s) => /insert into user_topic/i.test(s))).toBe(true);
    expect(calls.some((s) => /delete from emerging_topic/i.test(s))).toBe(true);
    // The inferred source is passed as a parameter on the upsert call.
    const upsert = db.calls.find((c) => /insert into user_topic/i.test(c.sql));
    expect(upsert?.params).toContain('inferred');
  });
});

describe('getFeedEvolutionNarrative (Req 24.7, 24.10) — Property 51', () => {
  it('returns an insufficient-history narrative when there is no reading history', async () => {
    const db = new FakeQueryable(responder({ dwellEvents: [] }));
    const result = await getFeedEvolutionNarrative({ db }, 'u-1', NOW);
    expect(result.hasHistory).toBe(false);
    expect(result.narrative.toLowerCase()).toContain('history');
  });

  it('returns a 1-3 sentence narrative when there is reading history', async () => {
    const db = new FakeQueryable(
      responder({ dwellEvents: [dwellEventRow()], userTopics: [] }),
    );
    const result = await getFeedEvolutionNarrative({ db }, 'u-1', NOW);
    expect(result.hasHistory).toBe(true);
    const sentences = result.narrative.split('.').filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(3);
  });
});

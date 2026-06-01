import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { acceptEmergingInterest, getEmergingInterests, getFeedEvolutionNarrative } from './emerging.js';

// Property-based tests for the Insights_Service emerging interests, acceptance,
// and feed-evolution narrative.

const NOW = Date.parse('2025-06-01T00:00:00.000Z');

const emergingRow = (topicId: string) => ({
  user_id: 'u-1',
  topic_id: topicId,
  detected_at: '2025-05-20T00:00:00.000Z',
});
const userTopicRow = (topicId: string) => ({
  user_id: 'u-1',
  topic_id: topicId,
  weight: 1,
  source: 'onboarding',
  muted: false,
  created_at: '2025-01-01T00:00:00.000Z',
});

function responder(opts: {
  emerging?: unknown[];
  userTopics?: unknown[];
  dwellEvents?: unknown[];
  findEmerging?: unknown[];
}) {
  return (sql: string): CannedResult => {
    if (/from emerging_topic/i.test(sql) && /and topic_id/i.test(sql)) {
      return { rows: opts.findEmerging ?? [] };
    }
    if (/from emerging_topic/i.test(sql)) return { rows: opts.emerging ?? [] };
    if (/from user_topic/i.test(sql)) return { rows: opts.userTopics ?? [] };
    if (/from feed_event/i.test(sql)) return { rows: opts.dwellEvents ?? [] };
    if (/insert into user_topic/i.test(sql)) return { rows: [userTopicRow('t-x')] };
    if (/delete from emerging_topic/i.test(sql)) return { rows: [emergingRow('t-x')] };
    return { rows: [] };
  };
}

describe('getEmergingInterests — Property 49 (capped & excludes added, Req 24.4)', () => {
  it('returns ≤3 topics, none already added', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }).map((n) => `t${n}`), { maxLength: 12 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }).map((n) => `t${n}`), { maxLength: 8 }),
        async (emergingIds, addedIds) => {
          const db = new FakeQueryable(
            responder({
              emerging: emergingIds.map(emergingRow),
              userTopics: addedIds.map(userTopicRow),
            }),
          );
          const result = await getEmergingInterests({ db }, 'u-1');
          const added = new Set(addedIds);
          expect(result.length).toBeLessThanOrEqual(3);
          for (const r of result) expect(added.has(r.topicId)).toBe(false);
        },
      ),
    );
  });
});

describe('acceptEmergingInterest — Property 50 (transition, Req 24.5, 24.6)', () => {
  it('present ⇒ adds (inferred) + removes; absent ⇒ NOT_FOUND with no mutation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (present) => {
        const calls: string[] = [];
        const db = new FakeQueryable((sql) => {
          calls.push(sql);
          return responder({ findEmerging: present ? [emergingRow('t-x')] : [] })(sql);
        });
        const result = await acceptEmergingInterest({ db }, 'u-1', 't-x');
        const inserted = calls.some((s) => /insert into user_topic/i.test(s));
        const removed = calls.some((s) => /delete from emerging_topic/i.test(s));
        if (present) {
          expect(result.ok).toBe(true);
          expect(inserted).toBe(true);
          expect(removed).toBe(true);
          const upsert = db.calls.find((c) => /insert into user_topic/i.test(c.sql));
          expect(upsert?.params).toContain('inferred');
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.error.code).toBe('NOT_FOUND');
          expect(inserted).toBe(false);
          expect(removed).toBe(false);
        }
      }),
    );
  });
});

describe('getFeedEvolutionNarrative — Property 51 (bounded narrative, Req 24.7, 24.10)', () => {
  it('is 1-3 sentences with history; an insufficient-history copy otherwise', async () => {
    const dwell = () => ({
      id: 'e-1',
      client_event_id: 'c-1',
      user_id: 'u-1',
      article_id: 'a-1',
      topic_id: null,
      type: 'dwell',
      payload: { dwellMs: 5000 },
      occurred_at: '2025-05-30T00:00:00.000Z',
      created_at: '2025-05-30T00:00:00.000Z',
    });
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (hasHistory) => {
        const db = new FakeQueryable(
          responder({ dwellEvents: hasHistory ? [dwell()] : [], userTopics: [] }),
        );
        const result = await getFeedEvolutionNarrative({ db }, 'u-1', NOW);
        expect(result.hasHistory).toBe(hasHistory);
        const sentences = result.narrative.split(/[.!?]/).filter((s) => s.trim().length > 0);
        expect(sentences.length).toBeGreaterThanOrEqual(1);
        expect(sentences.length).toBeLessThanOrEqual(3);
      }),
    );
  });
});

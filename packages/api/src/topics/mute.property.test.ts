// Feature: lumina, Property 45: Mute state round-trips and is idempotent
//
// Property-based coverage for the Feed_Service topic mute/unmute persistence
// service (Requirements 25.3, 25.4, 25.5). Property 45 (design.md): *For any*
// topic associated with a user, muting then unmuting (or unmuting then muting)
// returns the topic to its original muted state; muting an already-muted topic
// or unmuting an already-unmuted topic preserves the state and returns success.
//
// A single generated sequence of mute/unmute operations is replayed against an
// in-memory `user_topic` store (a Map keyed by user/topic behind a
// FakeQueryable whose `UPDATE ... muted = $3` mutates and returns the row, as
// in mute.test.ts), exercising the real `setUserTopicMuted` UPDATE path without
// a live database. Across each sequence three sub-properties are asserted:
//
//   (1) idempotency — after EVERY operation on an associated topic, the
//       persisted muted flag equals that operation's target (mute -> true,
//       unmute -> false), regardless of the topic's prior state. So re-muting
//       an already-muted topic (or re-unmuting an already-unmuted one) is a
//       no-op that still returns success (Requirements 25.4, 25.5).
//   (2) round-trip — the final persisted muted flag of each associated topic
//       equals the target of the LAST operation applied to it (and its seeded
//       state when untouched), so any mute/unmute round-trip returns the topic
//       to the expected state (Requirements 25.3, 25.4).
//   (3) not-found isolation — an operation on a topic NOT associated with the
//       user always returns the uniform NOT_FOUND envelope and never changes
//       any stored state.
//
// No implementation files are modified; the service is observed only through
// its public API (muteTopic/unmuteTopic) and the in-memory store's state.
//
// Validates: Requirements 25.3, 25.4, 25.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { QueryRow } from '../repositories/queryable.js';
import { createTopicMuteDataAccess, muteTopic, unmuteTopic } from './mute.js';

const RUNS = { numRuns: 200 } as const;

const USER = 'u-1';
// Topics seeded as user_topic associations (mute/unmute should succeed).
const ASSOCIATED_TOPICS = ['t-physics', 't-math', 't-bio', 't-cs'];
// Topics that never have a user_topic row (mute/unmute must yield NOT_FOUND).
const UNASSOCIATED_TOPICS = ['t-ghost', 't-missing'];
const ALL_TOPICS = [...ASSOCIATED_TOPICS, ...UNASSOCIATED_TOPICS];
const associatedSet = new Set(ASSOCIATED_TOPICS);

const storeKey = (userId: string, topicId: string): string => `${userId}::${topicId}`;

/** A raw `user_topic` row as returned by `pg`, with a given muted flag. */
function userTopicRow(topicId: string, muted: boolean): QueryRow {
  return {
    user_id: USER,
    topic_id: topicId,
    weight: '1',
    source: 'onboarding',
    muted,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
  };
}

/**
 * Build a {@link FakeQueryable} backed by an in-memory `user_topic` store keyed
 * by `(user_id, topic_id)`, seeded with each associated topic's initial muted
 * flag. The `UPDATE user_topic SET muted = $3` statement mutates the stored row
 * and returns it (mirroring `RETURNING`), or returns no rows when there is no
 * association — so idempotency and the not-found path run against real state
 * transitions rather than canned per-call rows. The store is returned alongside
 * the db so the test can inspect persisted state directly.
 */
function makeDb(seed: Record<string, boolean>): {
  db: FakeQueryable;
  store: Map<string, QueryRow>;
} {
  const store = new Map<string, QueryRow>();
  for (const topicId of ASSOCIATED_TOPICS) {
    store.set(storeKey(USER, topicId), userTopicRow(topicId, seed[topicId] ?? false));
  }
  const db = new FakeQueryable((sql, params) => {
    const n = normalizeSql(sql);
    if (n.includes('UPDATE user_topic SET muted =')) {
      const [userId, topicId, muted] = params as [string, string, boolean];
      const existing = store.get(storeKey(userId, topicId));
      if (!existing) return { rows: [] };
      existing.muted = muted;
      return { rows: [{ ...existing }] };
    }
    return { rows: [] };
  });
  return { db, store };
}

/** Snapshot every stored row's muted flag, for detecting unintended mutations. */
function snapshotMuted(store: Map<string, QueryRow>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const [key, row] of store) snap[key] = row.muted;
  return snap;
}

/** Read the persisted muted flag of an associated topic from the store. */
function storedMuted(store: Map<string, QueryRow>, topicId: string): boolean {
  const row = store.get(storeKey(USER, topicId));
  if (!row) throw new Error(`expected associated topic ${topicId} to be seeded`);
  return row.muted as boolean;
}

// --- Generators ------------------------------------------------------------

/** Initial muted state for each associated topic (exercises arbitrary priors). */
const seedArb = fc.record(
  Object.fromEntries(ASSOCIATED_TOPICS.map((t) => [t, fc.boolean()])),
) as fc.Arbitrary<Record<string, boolean>>;

/** A single mute/unmute operation against any topic (associated or not). */
const opArb = fc.record({
  kind: fc.constantFrom<'mute' | 'unmute'>('mute', 'unmute'),
  topicId: fc.constantFrom(...ALL_TOPICS),
});

/** A non-empty sequence of operations replayed against one shared store. */
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 40 });

describe('Property 45 - mute state round-trips and is idempotent', () => {
  it('idempotent per-op state, round-trip final state, and NOT_FOUND isolation across any op sequence (25.3, 25.4, 25.5)', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, opsArb, async (seed, ops) => {
        const { db, store } = makeDb(seed);
        const deps = createTopicMuteDataAccess(db);

        // Model of the expected persisted flag per associated topic: starts at
        // the seeded state, and each op on an associated topic overwrites it
        // with that op's target (the last op wins).
        const expected: Record<string, boolean> = { ...seed };

        for (const { kind, topicId } of ops) {
          const target = kind === 'mute';
          const before = snapshotMuted(store);

          const result =
            kind === 'mute'
              ? await muteTopic(deps, USER, topicId)
              : await unmuteTopic(deps, USER, topicId);

          if (associatedSet.has(topicId)) {
            // (1) Idempotency: the op succeeds and the persisted flag equals the
            // op's target regardless of the prior state.
            if (result.status !== 'ok') {
              throw new Error(
                `expected ok for associated topic ${topicId}, got ${result.status}`,
              );
            }
            expect(result.topic).toEqual({ topicId, muted: target });
            expect(storedMuted(store, topicId)).toBe(target);
            expected[topicId] = target;
          } else {
            // (3) Not-found isolation: uniform NOT_FOUND envelope, no state change.
            if (result.status !== 'not-found') {
              throw new Error(
                `expected not-found for unassociated topic ${topicId}, got ${result.status}`,
              );
            }
            expect(result.error).toEqual({
              error: {
                code: 'NOT_FOUND',
                message: 'Topic not found for user',
                details: { topicId },
              },
            });
            expect(snapshotMuted(store)).toEqual(before);
          }
        }

        // (2) Round-trip: each associated topic's final persisted flag equals
        // the target of the last op applied to it (or its seed when untouched).
        for (const topicId of ASSOCIATED_TOPICS) {
          expect(storedMuted(store, topicId)).toBe(expected[topicId]);
        }
      }),
      RUNS,
    );
  });
});

// Feature: lumina, Property 41: Saving is idempotent
//
// Property-based coverage for the Library_Service save surface
// (Requirements 21.1, 21.5). Property 41 (design.md): *For any* article and
// library state, saving an article not already saved adds it with read state
// `unread` and records exactly one `save` Feed_Event, while saving an
// already-saved article leaves the article and its read state unchanged and
// records no additional `save` event.
//
// Two sub-properties are exercised, each across a minimum of 100 iterations:
//
//   (1) idempotency on one (user, article) — for any number n >= 1 of
//       saveArticle calls on the SAME (user, article), exactly one saved row
//       exists, exactly one `save` Feed_Event is recorded across all calls, the
//       row's read state is `unread`, every returned record reports `unread`,
//       and only the FIRST call reports created = true.
//   (2) independence across keys — for any interleaving of saves over several
//       distinct (user, article) keys, each distinct key ends with exactly one
//       saved row and exactly one `save` event, every saved row is `unread`,
//       and created = true is reported exactly once per key (on its first
//       occurrence in call order). One key's saves never affect another's.
//
// The database is reached only through the narrow Queryable interface, modelled
// here by a stateful in-memory store behind a FakeQueryable responder: the
// `saved_article` INSERT ... ON CONFLICT DO NOTHING returns a freshly-created
// `unread` row only the first time for a (user, article) and no row thereafter
// (a re-save then reads the existing row back unchanged), and the `feed_event`
// INSERT ... ON CONFLICT DO NOTHING records `save` events. Deterministic
// newEventId/now are injected (as in saves.test.ts). No implementation files
// are modified; saveArticle is observed only through its public result and the
// recorded side effects.
//
// Validates: Requirements 21.1, 21.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  FakeQueryable,
  type CannedResult,
} from '../repositories/fake-queryable.js';
import { saveArticle } from './saves.js';

const RUNS = { numRuns: 200 } as const;

// Deterministic clock + saved-at instant so events/rows are assertable.
const NOW_ISO = '2024-05-01T00:00:00.000Z';
const SAVED_AT_ISO = '2024-04-01T00:00:00.000Z';

/** A `saved_article` row as the DB returns it (snake_case). */
interface SavedRow {
  user_id: string;
  article_id: string;
  read_state: 'read' | 'unread';
  saved_at: Date;
}

/** A recorded `save`/`unsave` Feed_Event, captured from the insert params. */
interface RecordedEvent {
  userId: string;
  clientEventId: string;
  articleId: string | null;
  type: string;
}

/**
 * A stateful in-memory model of the `saved_article` + `feed_event` tables,
 * driving a FakeQueryable responder. It interprets the exact parameterized SQL
 * the saved-articles and feed-events repositories issue:
 *
 *   - `INSERT INTO saved_article ... ON CONFLICT DO NOTHING RETURNING ...`
 *     inserts a fresh `unread` row and returns it ONLY the first time for a
 *     (user, article); a re-save matches the conflict and returns no row.
 *   - `SELECT ... FROM saved_article WHERE user_id = $1 AND article_id = $2`
 *     reads the existing row back (used by the service after a conflict).
 *   - `INSERT INTO feed_event ... ON CONFLICT DO NOTHING RETURNING ...` records
 *     the event, deduplicating on (user_id, client_event_id).
 */
class SaveStore {
  /** Surviving saved rows, keyed by (user, article). */
  readonly saved = new Map<string, SavedRow>();
  /** Every Feed_Event the service actually inserted, in order. */
  readonly events: RecordedEvent[] = [];
  private feedSeq = 0;

  private key(userId: string, articleId: string): string {
    return `${userId}\u0000${articleId}`;
  }

  respond(sql: string, params: readonly unknown[]): CannedResult {
    // Order matters: check the saved_article INSERT before the SELECT branch.
    if (/INSERT INTO saved_article/i.test(sql)) {
      const [userId, articleId] = params as [string, string];
      const k = this.key(userId, articleId);
      if (this.saved.has(k)) {
        // ON CONFLICT DO NOTHING: already saved => no row returned.
        return { rows: [] };
      }
      const row: SavedRow = {
        user_id: userId,
        article_id: articleId,
        read_state: 'unread', // column default on a fresh save (Req 21.1)
        saved_at: new Date(SAVED_AT_ISO),
      };
      this.saved.set(k, row);
      return { rows: [{ ...row }] };
    }

    if (/FROM saved_article/i.test(sql) && /^\s*SELECT/i.test(sql)) {
      const [userId, articleId] = params as [string, string];
      const row = this.saved.get(this.key(userId, articleId));
      return { rows: row ? [{ ...row }] : [] };
    }

    if (/INSERT INTO feed_event/i.test(sql)) {
      // params: [userId, clientEventId, articleId, topicId, type, payload, occurredAt]
      const userId = params[0] as string;
      const clientEventId = params[1] as string;
      const articleId = (params[2] ?? null) as string | null;
      const topicId = (params[3] ?? null) as string | null;
      const type = params[4] as string;
      const payload = params[5] as string;
      const occurredAt = params[6] as string;

      // ON CONFLICT (user_id, client_event_id) DO NOTHING.
      const duplicate = this.events.some(
        (e) => e.userId === userId && e.clientEventId === clientEventId,
      );
      const returned: CannedResult = {
        rows: [
          {
            id: `fe-${(this.feedSeq += 1)}`,
            client_event_id: clientEventId,
            user_id: userId,
            article_id: articleId,
            topic_id: topicId,
            type,
            payload: JSON.parse(payload) as Record<string, unknown>,
            occurred_at: new Date(occurredAt),
            created_at: new Date(occurredAt),
          },
        ],
      };
      if (duplicate) return { rows: [] };
      this.events.push({ userId, clientEventId, articleId, type });
      return returned;
    }

    throw new Error(`Unexpected SQL issued to SaveStore: ${sql}`);
  }
}

/**
 * Wire a fresh SaveStore behind a FakeQueryable with deterministic deps. The
 * event id is a per-scenario counter so distinct first-saves get distinct
 * `clientEventId`s (mirroring the Signal_Collector) and never collide on the
 * feed_event (user_id, client_event_id) conflict key.
 */
function makeDeps(store: SaveStore) {
  let eventSeq = 0;
  const db = new FakeQueryable((sql, params) => store.respond(sql, params));
  return {
    db,
    newEventId: () => `evt-${(eventSeq += 1)}`,
    now: () => new Date(NOW_ISO),
  };
}

/** `save` events recorded for a given (user, article). */
function saveEventsFor(store: SaveStore, userId: string, articleId: string) {
  return store.events.filter(
    (e) => e.type === 'save' && e.userId === userId && e.articleId === articleId,
  );
}

// Small pools so interleavings frequently repeat a key (exercising re-saves)
// while still spanning several distinct keys (exercising independence).
const userArb = fc.constantFrom('u-1', 'u-2', 'u-3');
const articleArb = fc.constantFrom('art-1', 'art-2', 'art-3', 'art-4', 'art-5');

describe('Property 41 - saving is idempotent', () => {
  it('(1) any n >= 1 saves of one (user, article): one row, one save event, unread, created only first (Reqs 21.1, 21.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        userArb,
        articleArb,
        fc.integer({ min: 1, max: 25 }),
        async (userId, articleId, n) => {
          const store = new SaveStore();
          const deps = makeDeps(store);

          const results = [];
          for (let i = 0; i < n; i += 1) {
            results.push(await saveArticle(deps, userId, articleId));
          }

          // Exactly one surviving saved row, and it is `unread` (Req 21.1).
          expect(store.saved.size).toBe(1);
          const row = [...store.saved.values()][0]!;
          expect(row.read_state).toBe('unread');

          // Every returned record reflects the unchanged, unread row (Req 21.5).
          for (const r of results) {
            expect(r.record.userId).toBe(userId);
            expect(r.record.articleId).toBe(articleId);
            expect(r.record.readState).toBe('unread');
          }

          // Exactly one `save` Feed_Event across all n calls (Reqs 21.1, 21.5).
          expect(saveEventsFor(store, userId, articleId)).toHaveLength(1);

          // Only the first save creates the row / reports created = true.
          expect(results[0]!.created).toBe(true);
          expect(results.slice(1).every((r) => r.created === false)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('(2) any interleaving over distinct keys: each key gets one row + one save event independently (Reqs 21.1, 21.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(userArb, articleArb), { minLength: 1, maxLength: 40 }),
        async (ops) => {
          const store = new SaveStore();
          const deps = makeDeps(store);

          // Track, per key, the index of the call that should report created.
          const firstSeen = new Set<string>();
          const keyOf = (u: string, a: string) => `${u}\u0000${a}`;

          for (const [userId, articleId] of ops) {
            const k = keyOf(userId, articleId);
            const isFirst = !firstSeen.has(k);
            const { created, record } = await saveArticle(deps, userId, articleId);

            // created is true exactly on a key's first occurrence in call order.
            expect(created).toBe(isFirst);
            // Read state is unread on first save and unchanged on every re-save.
            expect(record.readState).toBe('unread');
            firstSeen.add(k);
          }

          const distinctKeys = new Set(ops.map(([u, a]) => keyOf(u, a)));

          // One surviving row and one `save` event per distinct key, no more.
          expect(store.saved.size).toBe(distinctKeys.size);
          expect(store.events.filter((e) => e.type === 'save')).toHaveLength(
            distinctKeys.size,
          );

          // Independence: each distinct key has exactly one unread row and
          // exactly one `save` event, regardless of how other keys interleave.
          for (const [userId, articleId] of ops) {
            const row = store.saved.get(keyOf(userId, articleId));
            expect(row).toBeDefined();
            expect(row!.read_state).toBe('unread');
            expect(saveEventsFor(store, userId, articleId)).toHaveLength(1);
          }
        },
      ),
      RUNS,
    );
  });
});

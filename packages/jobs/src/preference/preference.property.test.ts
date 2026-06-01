import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import {
  MAX_TOPIC_WEIGHT,
  MIN_TOPIC_WEIGHT,
  SEVEN_DAYS_MS,
  clampTopicWeight,
  detectEmergingTopics,
  isTopicEmerging,
  recomputeTopicWeights,
  type TopicTimedEvent,
} from './topic-weights.js';
import { computeUserEmbedding, type TimedSignalEvent } from './centroid.js';

// Property-based tests for the Preference_Model_Updater (Requirements 14.6-14.9).

/** A full-width embedding whose every component is `v`. */
const vec = (v: number): number[] => new Array<number>(EMBEDDING_DIMENSIONS).fill(v);

describe('recomputeTopicWeights — Property 31 (weights clamped to [0,2], Req 14.6)', () => {
  it('clampTopicWeight always returns a finite value in [0,2]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: false }),
          fc.constant(Number.NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
        ),
        (x) => {
          const w = clampTopicWeight(x);
          expect(Number.isFinite(w)).toBe(true);
          expect(w).toBeGreaterThanOrEqual(MIN_TOPIC_WEIGHT);
          expect(w).toBeLessThanOrEqual(MAX_TOPIC_WEIGHT);
        },
      ),
    );
  });

  it('every recomputed topic weight is in [0,2] for arbitrary embeddings', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.array(
          fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.double({ min: -5, max: 5, noNaN: true })),
          { maxLength: 6 },
        ),
        (userVal, topicSpecs) => {
          const centroids = new Map(topicSpecs.map(([id, v]) => [id, vec(v)] as const));
          const weights = recomputeTopicWeights(vec(userVal), centroids);
          for (const w of weights.values()) {
            expect(w).toBeGreaterThanOrEqual(MIN_TOPIC_WEIGHT);
            expect(w).toBeLessThanOrEqual(MAX_TOPIC_WEIGHT);
          }
          // A weight is returned for every supplied topic key.
          expect(weights.size).toBe(centroids.size);
        },
      ),
    );
  });
});

describe('detectEmergingTopics — Property 32 (growth rule, Req 14.7)', () => {
  it('isTopicEmerging matches the exact growth rule for arbitrary signals', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (r, p) => {
          const expected = r > 1.2 * p || (p <= 0 && r > 0);
          expect(isTopicEmerging(r, p)).toBe(expected);
        },
      ),
    );
  });

  it('a topic is emerging exactly when its window signal sums satisfy the rule', () => {
    const NOW = 100 * SEVEN_DAYS_MS;
    // One `save` event (signal +0.50) placed in a chosen window contributes a
    // known positive signal; counts let us build arbitrary recent/preceding sums.
    const save = (topicId: string, occurredAtMs: number): TopicTimedEvent => ({
      topicId,
      type: 'save',
      occurredAtMs,
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }), // recent saves for t1
        fc.integer({ min: 0, max: 4 }), // preceding saves for t1
        (recentN, precedingN) => {
          fc.pre(recentN + precedingN > 0); // ensure non-empty window (else Req 14.8)
          const events: TopicTimedEvent[] = [];
          for (let i = 0; i < recentN; i++) events.push(save('t1', NOW - SEVEN_DAYS_MS / 2));
          for (let i = 0; i < precedingN; i++) events.push(save('t1', NOW - SEVEN_DAYS_MS - SEVEN_DAYS_MS / 2));
          const emerging = detectEmergingTopics(events, NOW);
          const r = recentN * 0.5;
          const p = precedingN * 0.5;
          expect(emerging.includes('t1')).toBe(isTopicEmerging(r, p));
        },
      ),
    );
  });

  it('no events in either 7-day window yields no emerging topics (Req 14.8)', () => {
    const NOW = 100 * SEVEN_DAYS_MS;
    const old: TopicTimedEvent[] = [{ topicId: 't1', type: 'save', occurredAtMs: NOW - 100 * SEVEN_DAYS_MS }];
    expect(detectEmergingTopics(old, NOW)).toEqual([]);
    expect(detectEmergingTopics([], NOW)).toEqual([]);
  });
});

describe('computeUserEmbedding — Property 33 (empty-window no-op, Req 14.9)', () => {
  it('leaves the model unchanged whenever the 30-day window holds no events', () => {
    const NOW = 1_000 * 24 * 60 * 60 * 1000;
    fc.assert(
      fc.property(
        // Events that are all OUTSIDE the trailing 30-day window: either far in
        // the past or in the future relative to NOW.
        fc.array(
          fc.record({
            articleId: fc.constantFrom('a', 'b', null),
            type: fc.constantFrom('save', 'dwell', 'skip'),
            occurredAtMs: fc.oneof(
              fc.integer({ min: 0, max: NOW - 31 * 24 * 60 * 60 * 1000 }), // older than 30d
              fc.integer({ min: NOW + 1, max: NOW + 10 * 24 * 60 * 60 * 1000 }), // future
            ),
          }),
          { maxLength: 15 },
        ),
        (raw) => {
          const events = raw as TimedSignalEvent[];
          const embeddings = new Map([['a', vec(0.3)], ['b', vec(0.7)]]);
          const result = computeUserEmbedding(events, embeddings, NOW);
          expect(result.status).toBe('unchanged');
          if (result.status === 'unchanged') expect(result.reason).toBe('empty-window');
        },
      ),
    );
  });
});

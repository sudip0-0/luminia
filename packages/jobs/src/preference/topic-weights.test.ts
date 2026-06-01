import { describe, it, expect } from 'vitest';
import { EMBEDDING_DIMENSIONS, type FeedEventType } from '@lumina/shared';
import {
  MIN_TOPIC_WEIGHT,
  MAX_TOPIC_WEIGHT,
  SEVEN_DAYS_MS,
  EMERGING_GROWTH_FACTOR,
  clampTopicWeight,
  recomputeTopicWeights,
  isTopicEmerging,
  detectEmergingTopics,
  type TopicTimedEvent,
} from './topic-weights.js';

// A fixed "run start" so tests are deterministic.
const NOW = Date.UTC(2024, 0, 31, 12, 0, 0); // 2024-01-31T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

/** Build an EMBEDDING_DIMENSIONS-wide embedding from a per-index fill function. */
function makeEmbedding(fill: (i: number) => number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => fill(i));
}

function evt(
  type: FeedEventType,
  topicId: string | null,
  occurredAtMs: number,
  payload?: Record<string, unknown>,
): TopicTimedEvent {
  return { type, topicId, occurredAtMs, payload };
}

describe('clampTopicWeight — clamps to [0.0, 2.0] (Requirement 14.6)', () => {
  it('returns values inside the range unchanged', () => {
    expect(clampTopicWeight(0)).toBe(0);
    expect(clampTopicWeight(0.5)).toBe(0.5);
    expect(clampTopicWeight(1)).toBe(1);
    expect(clampTopicWeight(2)).toBe(2);
  });

  it('clamps at the inclusive lower boundary 0.0', () => {
    expect(clampTopicWeight(MIN_TOPIC_WEIGHT)).toBe(0);
    expect(clampTopicWeight(-0.0001)).toBe(0);
    expect(clampTopicWeight(-1)).toBe(0); // cosine can be as low as -1
    expect(clampTopicWeight(-100)).toBe(0);
  });

  it('clamps at the inclusive upper boundary 2.0', () => {
    expect(clampTopicWeight(MAX_TOPIC_WEIGHT)).toBe(2);
    expect(clampTopicWeight(2.0001)).toBe(2);
    expect(clampTopicWeight(5)).toBe(2);
    expect(clampTopicWeight(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it('maps NaN to the lower boundary so the result is always finite and in range', () => {
    expect(clampTopicWeight(Number.NaN)).toBe(0);
  });
});

describe('recomputeTopicWeights — cosine similarity clamped to [0,2] (Requirement 14.6, Property 31)', () => {
  it('assigns weight 1.0 for an identical (perfectly aligned) centroid', () => {
    const user = makeEmbedding((i) => (i % 2 === 0 ? 1 : -1));
    const centroids = new Map([['same', makeEmbedding((i) => (i % 2 === 0 ? 1 : -1))]]);
    const weights = recomputeTopicWeights(user, centroids);
    expect(weights.get('same')).toBeCloseTo(1, 10);
  });

  it('clamps a negative cosine (opposite centroid) up to the lower bound 0.0', () => {
    const user = makeEmbedding(() => 1);
    const centroids = new Map([['opposite', makeEmbedding(() => -1)]]); // cosine -1
    const weights = recomputeTopicWeights(user, centroids);
    expect(weights.get('opposite')).toBe(0);
  });

  it('assigns weight 0.0 for an orthogonal centroid (cosine 0)', () => {
    // user nonzero only on even indices; centroid nonzero only on odd indices.
    const user = makeEmbedding((i) => (i % 2 === 0 ? 1 : 0));
    const centroids = new Map([['orthogonal', makeEmbedding((i) => (i % 2 === 0 ? 0 : 1))]]);
    const weights = recomputeTopicWeights(user, centroids);
    expect(weights.get('orthogonal')).toBeCloseTo(0, 10);
  });

  it('returns a weight in [0,2] for every supplied topic, scaled by alignment', () => {
    const user = makeEmbedding(() => 1);
    const centroids = new Map([
      ['aligned', makeEmbedding(() => 1)],
      ['half', makeEmbedding((i) => (i < EMBEDDING_DIMENSIONS / 2 ? 1 : 0))],
      ['opposed', makeEmbedding(() => -1)],
    ]);
    const weights = recomputeTopicWeights(user, centroids);
    for (const [, w] of weights) {
      expect(w).toBeGreaterThanOrEqual(MIN_TOPIC_WEIGHT);
      expect(w).toBeLessThanOrEqual(MAX_TOPIC_WEIGHT);
    }
    expect(weights.get('aligned')).toBeCloseTo(1, 10);
    expect(weights.get('opposed')).toBe(0);
    // partial overlap → strictly between 0 and 1.
    const half = weights.get('half') ?? Number.NaN;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it('assigns weight 0.0 when the user embedding is not a usable full-width vector', () => {
    const centroids = new Map([['t', makeEmbedding(() => 1)]]);
    const weights = recomputeTopicWeights([1, 2, 3], centroids); // wrong width
    expect(weights.get('t')).toBe(0);
  });

  it('assigns weight 0.0 to a topic whose centroid is not a usable full-width vector', () => {
    const user = makeEmbedding(() => 1);
    const centroids = new Map<string, number[]>([
      ['good', makeEmbedding(() => 1)],
      ['bad', [1, 2, 3]], // wrong width
    ]);
    const weights = recomputeTopicWeights(user, centroids);
    expect(weights.get('good')).toBeCloseTo(1, 10);
    expect(weights.get('bad')).toBe(0);
  });

  it('returns an entry for every topic key and no extras', () => {
    const user = makeEmbedding(() => 1);
    const centroids = new Map([
      ['a', makeEmbedding(() => 1)],
      ['b', makeEmbedding(() => 1)],
    ]);
    const weights = recomputeTopicWeights(user, centroids);
    expect([...weights.keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('isTopicEmerging — growth rule (Requirement 14.7, Property 32)', () => {
  it('is true strictly above the r > 1.2*p threshold and false exactly on it', () => {
    const p = 1.0;
    const threshold = EMERGING_GROWTH_FACTOR * p; // 1.2
    expect(isTopicEmerging(threshold, p)).toBe(false); // exactly on the boundary
    expect(isTopicEmerging(threshold + 1e-9, p)).toBe(true); // just above
    expect(isTopicEmerging(threshold - 1e-9, p)).toBe(false); // just below
  });

  it('applies the p<=0 & r>0 rule (growth from a flat/declining base)', () => {
    expect(isTopicEmerging(0.01, 0)).toBe(true); // p == 0, r > 0
    expect(isTopicEmerging(0.5, -3)).toBe(true); // p < 0, r > 0
    expect(isTopicEmerging(0, 0)).toBe(false); // p <= 0 but r not > 0
    expect(isTopicEmerging(-0.1, 0)).toBe(false); // p <= 0 but r negative
    // r=-3, p=-2: first clause -3 > 1.2*-2 (=-2.4) is false AND r not > 0 ⇒ not emerging.
    expect(isTopicEmerging(-3, -2)).toBe(false);
  });

  it('treats a shrinking signal as not emerging', () => {
    expect(isTopicEmerging(0.5, 1.0)).toBe(false);
    expect(isTopicEmerging(1.0, 1.0)).toBe(false); // flat, below 1.2x
  });
});

describe('detectEmergingTopics — windowed classification (Requirements 14.7, 14.8, Property 32)', () => {
  it('records no emerging topics when there are no events in either 7-day window (Requirement 14.8)', () => {
    // All events lie strictly outside the most-recent 14 days.
    const events = [
      evt('save', 't1', NOW - 20 * DAY),
      evt('share', 't2', NOW - 30 * DAY),
      evt('save', 't1', NOW + DAY), // future relative to run start
    ];
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('records no emerging topics for an empty event list (Requirement 14.8)', () => {
    expect(detectEmergingTopics([], NOW)).toEqual([]);
  });

  it('classifies a topic as emerging when recent signal exceeds 1.2x the preceding signal', () => {
    // preceding window: one save (0.50). recent window: two saves (1.00).
    // 1.00 > 1.2 * 0.50 (= 0.60) ⇒ emerging.
    const events = [
      evt('save', 'growing', NOW - 10 * DAY), // preceding window
      evt('save', 'growing', NOW - 3 * DAY), // recent window
      evt('save', 'growing', NOW - 1 * DAY), // recent window
    ];
    expect(detectEmergingTopics(events, NOW)).toEqual(['growing']);
  });

  it('does NOT classify a topic sitting exactly on the r = 1.2*p boundary as emerging', () => {
    // preceding: save (0.50) + 5 impressions (5*0.05=0.25) ⇒ p = 0.75? Keep it simple:
    // Use scroll_depth to dial exact numbers. preceding p = 0.50 (one save).
    // recent r must equal 0.60 exactly: save (0.50) + scroll_depth*1.0 (0.10) = 0.60.
    const events = [
      evt('save', 't', NOW - 9 * DAY), // preceding: 0.50
      evt('save', 't', NOW - 2 * DAY), // recent: 0.50
      evt('scroll_depth', 't', NOW - 1 * DAY, { scrollProportion: 1 }), // recent: +0.10 ⇒ 0.60
    ];
    // r (0.60) === 1.2 * p (0.50) ⇒ NOT strictly greater ⇒ not emerging.
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('classifies a topic as emerging via the p<=0 & r>0 rule (no preceding activity)', () => {
    // Only recent-window positive activity, nothing in the preceding window.
    const events = [evt('save', 'fresh', NOW - 2 * DAY)];
    expect(detectEmergingTopics(events, NOW)).toEqual(['fresh']);
  });

  it('classifies as emerging when the preceding signal is negative and the recent signal is positive', () => {
    const events = [
      evt('mute_topic', 'rebound', NOW - 10 * DAY), // preceding: -1.00 (p < 0)
      evt('save', 'rebound', NOW - 1 * DAY), // recent: +0.50 (r > 0)
    ];
    expect(detectEmergingTopics(events, NOW)).toEqual(['rebound']);
  });

  it('does not classify a topic as emerging when its recent signal merely matches a positive base', () => {
    const events = [
      evt('save', 'flat', NOW - 10 * DAY), // preceding: 0.50
      evt('save', 'flat', NOW - 2 * DAY), // recent: 0.50 (not > 1.2*0.50)
    ];
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('respects the half-open window boundaries (no double-counting at the 7-day edge)', () => {
    const recentStart = NOW - SEVEN_DAYS_MS;
    // Event exactly at the recent-window start belongs to the PRECEDING window.
    const events = [
      evt('save', 't', recentStart), // preceding window (occurredAt <= recentStart)
      evt('save', 't', NOW - DAY), // recent window
    ];
    // preceding p = 0.50, recent r = 0.50 ⇒ 0.50 not > 0.60 ⇒ not emerging.
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('ignores events with a non-finite timestamp', () => {
    const events = [
      evt('save', 't', Number.NaN),
      evt('save', 't', Number.POSITIVE_INFINITY),
    ];
    // No finite in-window events ⇒ none emerging (Requirement 14.8).
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('counts topic-less events for window-emptiness but they contribute no per-topic signal', () => {
    // A session_end (no topic) lands in the recent window: the window is NOT
    // empty, but there is no topic with positive signal, so none emerge.
    const events = [evt('session_end', null, NOW - 1 * DAY)];
    expect(detectEmergingTopics(events, NOW)).toEqual([]);
  });

  it('returns emerging topic ids sorted ascending and deduplicated', () => {
    const events = [
      evt('save', 'zebra', NOW - 1 * DAY),
      evt('save', 'apple', NOW - 2 * DAY),
      evt('save', 'mango', NOW - 3 * DAY),
    ];
    expect(detectEmergingTopics(events, NOW)).toEqual(['apple', 'mango', 'zebra']);
  });
});

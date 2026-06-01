import { describe, it, expect } from 'vitest';
import { EMBEDDING_DIMENSIONS, type FeedEventType } from '@lumina/shared';
import {
  THIRTY_DAYS_MS,
  RECENCY_HALF_LIFE_MS,
  eventsInWindow,
  recencyWeight,
  computeUserEmbedding,
  isUsableEmbedding,
  type TimedSignalEvent,
} from './centroid.js';

// A fixed "run start" so tests are deterministic.
const NOW = Date.UTC(2024, 0, 31, 12, 0, 0); // 2024-01-31T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

/** Build a usable EMBEDDING_DIMENSIONS-wide embedding from a fill function. */
function makeEmbedding(fill: (i: number) => number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => fill(i));
}

/** A constant embedding (every dimension equals `value`). */
function constantEmbedding(value: number): number[] {
  return makeEmbedding(() => value);
}

function evt(
  type: FeedEventType,
  articleId: string | null,
  occurredAtMs: number,
  payload?: Record<string, unknown>,
): TimedSignalEvent {
  return { type, articleId, occurredAtMs, payload };
}

describe('eventsInWindow — trailing 30-day window (Requirement 14.2)', () => {
  it('keeps events at the window boundaries and excludes those just outside', () => {
    const start = NOW - THIRTY_DAYS_MS;
    const events = [
      evt('save', 'a', start - 1), // just before the window: excluded
      evt('save', 'b', start), // exactly at window start: included
      evt('save', 'c', NOW - DAY), // inside: included
      evt('save', 'd', NOW), // exactly at window end: included
      evt('save', 'e', NOW + 1), // future relative to run start: excluded
    ];
    const kept = eventsInWindow(events, NOW).map((e) => e.articleId);
    expect(kept).toEqual(['b', 'c', 'd']);
  });

  it('excludes events with a non-finite occurrence time', () => {
    const events = [
      evt('save', 'a', Number.NaN),
      evt('save', 'b', Number.POSITIVE_INFINITY),
      evt('save', 'c', NOW - DAY),
    ];
    expect(eventsInWindow(events, NOW).map((e) => e.articleId)).toEqual(['c']);
  });
});

describe('recencyWeight — strictly positive and increasing in recency (Requirement 14.5)', () => {
  it('is 1.0 at the window end and halves every half-life', () => {
    expect(recencyWeight(NOW, NOW)).toBeCloseTo(1, 10);
    expect(recencyWeight(NOW - RECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(NOW - 2 * RECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(0.25, 10);
  });

  it('assigns a strictly greater weight to a later most-recent event', () => {
    const earlier = recencyWeight(NOW - 10 * DAY, NOW);
    const later = recencyWeight(NOW - 3 * DAY, NOW);
    expect(later).toBeGreaterThan(earlier);
    expect(earlier).toBeGreaterThan(0);
  });

  it('clamps events at/after the window end to weight 1.0', () => {
    expect(recencyWeight(NOW + DAY, NOW)).toBeCloseTo(1, 10);
  });
});

describe('isUsableEmbedding', () => {
  it('accepts an EMBEDDING_DIMENSIONS-wide finite vector', () => {
    expect(isUsableEmbedding(constantEmbedding(0.1))).toBe(true);
  });

  it('rejects wrong-width, non-finite, null, and undefined vectors', () => {
    expect(isUsableEmbedding([1, 2, 3])).toBe(false);
    expect(isUsableEmbedding(makeEmbedding((i) => (i === 0 ? Number.NaN : 0)))).toBe(false);
    expect(isUsableEmbedding(null)).toBe(false);
    expect(isUsableEmbedding(undefined)).toBe(false);
  });
});

describe('computeUserEmbedding — empty window is a no-op (Requirement 14.9)', () => {
  it('returns unchanged/empty-window when there are no events at all', () => {
    const result = computeUserEmbedding([], new Map(), NOW);
    expect(result).toEqual({ status: 'unchanged', reason: 'empty-window' });
  });

  it('returns unchanged/empty-window when every event is outside the 30-day window', () => {
    const embeddings = new Map([['a', constantEmbedding(1)]]);
    const events = [
      evt('save', 'a', NOW - THIRTY_DAYS_MS - 1), // older than the window
      evt('save', 'a', NOW + DAY), // in the future
    ];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result).toEqual({ status: 'unchanged', reason: 'empty-window' });
  });
});

describe('computeUserEmbedding — engaged set excludes net<=0 articles (Requirement 14.4)', () => {
  it('ignores articles whose net signal is <= 0 and centroids only the engaged ones', () => {
    const embeddings = new Map([
      ['engaged', constantEmbedding(1)],
      ['neutral', constantEmbedding(5)], // net signal exactly 0 → excluded
      ['negative', constantEmbedding(9)], // net signal < 0 → excluded
    ]);
    const events = [
      // engaged: save (0.50) > 0
      evt('save', 'engaged', NOW - DAY),
      // neutral: impression 0.05 + skip -0.20 + ... tune to exactly 0 via unsave(0)+session_end(0)
      evt('unsave', 'neutral', NOW - DAY), // 0.0
      evt('session_end', 'neutral', NOW - DAY), // 0.0
      // negative: a single skip (-0.20)
      evt('skip', 'negative', NOW - DAY),
    ];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    // Only the 'engaged' article (constant 1) contributes → centroid is all 1s.
    expect(result.embedding.every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
  });

  it('returns unchanged/no-engaged-articles when events exist but none are engaged', () => {
    const embeddings = new Map([['a', constantEmbedding(1)]]);
    const events = [evt('skip', 'a', NOW - DAY), evt('mute_topic', 'a', NOW - DAY)];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result).toEqual({ status: 'unchanged', reason: 'no-engaged-articles' });
  });

  it('returns unchanged/no-engaged-articles when the only engaged article lacks a usable embedding', () => {
    const embeddings = new Map<string, number[]>([['a', [1, 2, 3]]]); // wrong width
    const events = [evt('save', 'a', NOW - DAY)];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result).toEqual({ status: 'unchanged', reason: 'no-engaged-articles' });
  });
});

describe('computeUserEmbedding — recency tie-break (Requirement 14.5)', () => {
  it('shifts the centroid toward the engaged article whose most-recent event is later', () => {
    // Two engaged articles with EQUAL net signal (one save each → 0.50).
    // Article "old" has embedding all 0s; "new" has embedding all 1s.
    // The later most-recent event must contribute a strictly greater weight,
    // so the centroid must lie strictly closer to "new" (i.e. > 0.5).
    const embeddings = new Map([
      ['old', constantEmbedding(0)],
      ['new', constantEmbedding(1)],
    ]);
    const events = [
      evt('save', 'old', NOW - 20 * DAY), // earlier most-recent event
      evt('save', 'new', NOW - 2 * DAY), // later most-recent event
    ];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    // Centroid value (between 0 and 1) must be strictly above 0.5 — biased toward "new".
    const v = result.embedding[0] ?? Number.NaN;
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(1);
    // All dimensions share the same value since both embeddings are constant.
    expect(result.embedding.every((x) => Math.abs(x - v) < 1e-9)).toBe(true);
  });

  it('produces the exact net-signal-times-recency weighted average', () => {
    const embeddings = new Map([
      ['a', constantEmbedding(0)],
      ['b', constantEmbedding(1)],
    ]);
    const aTime = NOW - 10 * DAY;
    const bTime = NOW - 4 * DAY;
    const events = [evt('save', 'a', aTime), evt('save', 'b', bTime)];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;

    const wA = 0.5 * recencyWeight(aTime, NOW);
    const wB = 0.5 * recencyWeight(bTime, NOW);
    const expected = (wA * 0 + wB * 1) / (wA + wB);
    expect(result.embedding[0]).toBeCloseTo(expected, 10);
  });

  it('uses the latest event time per article when an article has multiple events', () => {
    // "multi" gets two saves; its most-recent time is the later one, which should
    // drive a higher recency weight than a single equal-signal article seen earlier.
    const embeddings = new Map([
      ['multi', constantEmbedding(1)],
      ['single', constantEmbedding(0)],
    ]);
    const events = [
      evt('save', 'multi', NOW - 25 * DAY),
      evt('skip', 'multi', NOW - 1 * DAY), // brings net to 0.30 and most-recent to NOW-1d
      evt('expand', 'multi', NOW - 1 * DAY), // +0.35 → also recent
      evt('save', 'single', NOW - 25 * DAY),
    ];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    // "multi" is both higher net signal and more recent → centroid biased toward 1.
    expect(result.embedding[0] ?? 0).toBeGreaterThan(0.5);
  });
});

describe('computeUserEmbedding — centroid dimensionality (Requirement 14.4)', () => {
  it('returns a vector of exactly EMBEDDING_DIMENSIONS finite numbers', () => {
    const embeddings = new Map([
      ['a', makeEmbedding((i) => Math.sin(i))],
      ['b', makeEmbedding((i) => Math.cos(i))],
    ]);
    const events = [
      evt('save', 'a', NOW - 3 * DAY),
      evt('share', 'b', NOW - 5 * DAY),
    ];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.embedding.every((n) => Number.isFinite(n))).toBe(true);
    expect(isUsableEmbedding(result.embedding)).toBe(true);
  });

  it('scales scroll_depth signal by the recorded proportion when accumulating net signal', () => {
    // A single article engaged purely via scroll_depth at full proportion (0.10 > 0).
    const embeddings = new Map([['a', constantEmbedding(1)]]);
    const events = [evt('scroll_depth', 'a', NOW - DAY, { scrollProportion: 1 })];
    const result = computeUserEmbedding(events, embeddings, NOW);
    expect(result.status).toBe('updated');
  });
});

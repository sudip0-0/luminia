import { describe, it, expect } from 'vitest';
import { FEED_EVENT_TYPES, type FeedEventType } from '@lumina/shared';
import {
  EVENT_TYPE_WEIGHTS,
  FIXED_WEIGHT_EVENT_TYPES,
  readScrollProportion,
  eventSignal,
  aggregateSignal,
  aggregateSignalByKey,
  type SignalEvent,
} from './signal-weights.js';

describe('EVENT_TYPE_WEIGHTS', () => {
  it('defines the exact base weight for each event type (Requirement 14.3)', () => {
    expect(EVENT_TYPE_WEIGHTS).toEqual({
      impression: 0.05,
      dwell: 0.15,
      expand: 0.35,
      scroll_depth: 0.1,
      save: 0.5,
      unsave: 0.0,
      share: 0.6,
      link_out: 0.45,
      skip: -0.2,
      session_end: 0.0,
      mute_topic: -1.0,
    });
  });

  it('has a weight for every FeedEventType and no extras', () => {
    expect(Object.keys(EVENT_TYPE_WEIGHTS).sort()).toEqual([...FEED_EVENT_TYPES].sort());
  });

  it('FIXED_WEIGHT_EVENT_TYPES is every type except scroll_depth', () => {
    expect(FIXED_WEIGHT_EVENT_TYPES).not.toContain('scroll_depth');
    expect([...FIXED_WEIGHT_EVENT_TYPES, 'scroll_depth'].sort()).toEqual(
      [...FEED_EVENT_TYPES].sort(),
    );
  });
});

describe('eventSignal — fixed-weight event types', () => {
  it('returns the fixed weight for each non-scroll_depth type', () => {
    for (const type of FIXED_WEIGHT_EVENT_TYPES) {
      expect(eventSignal({ type })).toBe(EVENT_TYPE_WEIGHTS[type]);
    }
  });

  it('ignores any payload on fixed-weight types', () => {
    expect(eventSignal({ type: 'save', payload: { scrollProportion: 0.9, foo: 1 } })).toBe(0.5);
    expect(eventSignal({ type: 'skip', payload: { dwellMs: 100 } })).toBe(-0.2);
    expect(eventSignal({ type: 'mute_topic', payload: null })).toBe(-1.0);
  });

  it('assigns the documented signed weights', () => {
    expect(eventSignal({ type: 'impression' })).toBe(0.05);
    expect(eventSignal({ type: 'dwell' })).toBe(0.15);
    expect(eventSignal({ type: 'expand' })).toBe(0.35);
    expect(eventSignal({ type: 'share' })).toBe(0.6);
    expect(eventSignal({ type: 'link_out' })).toBe(0.45);
    expect(eventSignal({ type: 'unsave' })).toBe(0.0);
    expect(eventSignal({ type: 'session_end' })).toBe(0.0);
  });
});

describe('readScrollProportion — clamping and defaults', () => {
  it('returns a valid in-range proportion unchanged', () => {
    expect(readScrollProportion({ scrollProportion: 0 })).toBe(0);
    expect(readScrollProportion({ scrollProportion: 0.5 })).toBe(0.5);
    expect(readScrollProportion({ scrollProportion: 1 })).toBe(1);
  });

  it('clamps out-of-range proportions to [0,1]', () => {
    expect(readScrollProportion({ scrollProportion: 1.5 })).toBe(1);
    expect(readScrollProportion({ scrollProportion: 42 })).toBe(1);
    expect(readScrollProportion({ scrollProportion: -0.3 })).toBe(0);
    expect(readScrollProportion({ scrollProportion: -100 })).toBe(0);
  });

  it('treats missing payload, missing field, and non-finite/non-number as 0', () => {
    expect(readScrollProportion(undefined)).toBe(0);
    expect(readScrollProportion(null)).toBe(0);
    expect(readScrollProportion({})).toBe(0);
    expect(readScrollProportion({ scrollProportion: Number.NaN })).toBe(0);
    expect(readScrollProportion({ scrollProportion: Number.POSITIVE_INFINITY })).toBe(0);
    expect(readScrollProportion({ scrollProportion: '0.7' as unknown as number })).toBe(0);
  });
});

describe('eventSignal — scroll_depth scaling', () => {
  it('scales the 0.10 coefficient by the clamped proportion', () => {
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: 0 } })).toBe(0);
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: 0.5 } })).toBeCloseTo(
      0.05,
      10,
    );
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: 1 } })).toBeCloseTo(
      0.1,
      10,
    );
  });

  it('clamps out-of-range proportions before scaling', () => {
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: 5 } })).toBeCloseTo(
      0.1,
      10,
    );
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: -2 } })).toBe(0);
  });

  it('treats a missing or malformed payload as proportion 0', () => {
    expect(eventSignal({ type: 'scroll_depth' })).toBe(0);
    expect(eventSignal({ type: 'scroll_depth', payload: {} })).toBe(0);
    expect(eventSignal({ type: 'scroll_depth', payload: null })).toBe(0);
    expect(eventSignal({ type: 'scroll_depth', payload: { scrollProportion: Number.NaN } })).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const event: SignalEvent = { type: 'scroll_depth', payload: { scrollProportion: 0.42 } };
    expect(eventSignal(event)).toBe(eventSignal(event));
  });
});

describe('eventSignal — totality on unknown types', () => {
  it('returns 0 for an unrecognized event type', () => {
    expect(eventSignal({ type: 'totally_unknown' as FeedEventType })).toBe(0);
  });
});

describe('aggregateSignal — sum helper', () => {
  it('returns 0 for an empty collection', () => {
    expect(aggregateSignal([])).toBe(0);
  });

  it('sums per-event signals, including the special scroll_depth scaling', () => {
    const events: SignalEvent[] = [
      { type: 'impression' }, // 0.05
      { type: 'dwell' }, // 0.15
      { type: 'scroll_depth', payload: { scrollProportion: 0.5 } }, // 0.05
      { type: 'save' }, // 0.50
      { type: 'skip' }, // -0.20
    ];
    // 0.05 + 0.15 + 0.05 + 0.50 - 0.20 = 0.55
    expect(aggregateSignal(events)).toBeCloseTo(0.55, 10);
  });

  it('can sum to a net-negative signal', () => {
    const events: SignalEvent[] = [
      { type: 'impression' }, // 0.05
      { type: 'mute_topic' }, // -1.00
    ];
    expect(aggregateSignal(events)).toBeCloseTo(-0.95, 10);
  });
});

describe('aggregateSignalByKey — per-article grouping', () => {
  it('groups and sums signals by key', () => {
    const events = [
      { type: 'impression' as FeedEventType, articleId: 'a' },
      { type: 'save' as FeedEventType, articleId: 'a' },
      { type: 'skip' as FeedEventType, articleId: 'b' },
      { type: 'scroll_depth' as FeedEventType, articleId: 'b', payload: { scrollProportion: 1 } },
    ];
    const totals = aggregateSignalByKey(events, (e) => e.articleId);
    expect(totals.get('a')).toBeCloseTo(0.55, 10); // 0.05 + 0.50
    expect(totals.get('b')).toBeCloseTo(-0.1, 10); // -0.20 + 0.10
  });

  it('skips events whose key is null or undefined', () => {
    const events = [
      { type: 'session_end' as FeedEventType, articleId: null },
      { type: 'save' as FeedEventType, articleId: 'a' },
    ];
    const totals = aggregateSignalByKey(events, (e) => e.articleId);
    expect(totals.has('a')).toBe(true);
    expect(totals.size).toBe(1);
  });
});

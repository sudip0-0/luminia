import { describe, it, expect } from 'vitest';
import {
  estimateReadTimeMinutes,
  DEFAULT_WORDS_PER_MINUTE,
  MIN_READ_TIME_MINUTES,
} from './read-time.js';

describe('estimateReadTimeMinutes (whole-minute read time, minimum 1)', () => {
  it('returns the minimum of 1 for empty content (Requirement 6.6)', () => {
    expect(estimateReadTimeMinutes(0)).toBe(MIN_READ_TIME_MINUTES);
    expect(estimateReadTimeMinutes(0)).toBe(1);
  });

  it('returns at least 1 even for very short, non-empty content', () => {
    // 10 words / 200 wpm = 0.05 -> rounds to 0 -> floored at 1.
    expect(estimateReadTimeMinutes(10)).toBe(1);
    // Exactly half a minute of words rounds to 1 (round-half-up) but is floored at 1 anyway.
    expect(estimateReadTimeMinutes(DEFAULT_WORDS_PER_MINUTE / 2)).toBe(1);
  });

  it('rounds the words/wpm quotient to the nearest whole minute', () => {
    // 200 words / 200 wpm = 1.0 -> 1 minute.
    expect(estimateReadTimeMinutes(200)).toBe(1);
    // 300 words / 200 wpm = 1.5 -> rounds to 2 minutes.
    expect(estimateReadTimeMinutes(300)).toBe(2);
    // 500 words / 200 wpm = 2.5 -> rounds to 3 minutes (round half up).
    expect(estimateReadTimeMinutes(500)).toBe(3);
    // 449 words / 200 wpm = 2.245 -> rounds down to 2 minutes.
    expect(estimateReadTimeMinutes(449)).toBe(2);
    // 1000 words / 200 wpm = 5.0 -> 5 minutes.
    expect(estimateReadTimeMinutes(1000)).toBe(5);
  });

  it('always returns an integer', () => {
    for (const words of [0, 1, 199, 250, 333, 1234, 9999]) {
      expect(Number.isInteger(estimateReadTimeMinutes(words))).toBe(true);
    }
  });

  it('honours a custom words-per-minute reading speed', () => {
    // 1000 words at 250 wpm = 4.0 -> 4 minutes.
    expect(estimateReadTimeMinutes(1000, { wordsPerMinute: 250 })).toBe(4);
    // 1000 words at 100 wpm = 10.0 -> 10 minutes.
    expect(estimateReadTimeMinutes(1000, { wordsPerMinute: 100 })).toBe(10);
  });

  it('falls back to the default wpm for invalid speeds', () => {
    expect(estimateReadTimeMinutes(1000, { wordsPerMinute: 0 })).toBe(
      estimateReadTimeMinutes(1000),
    );
    expect(estimateReadTimeMinutes(1000, { wordsPerMinute: -50 })).toBe(
      estimateReadTimeMinutes(1000),
    );
    expect(estimateReadTimeMinutes(1000, { wordsPerMinute: Number.NaN })).toBe(
      estimateReadTimeMinutes(1000),
    );
    expect(
      estimateReadTimeMinutes(1000, { wordsPerMinute: Number.POSITIVE_INFINITY }),
    ).toBe(estimateReadTimeMinutes(1000));
  });

  it('treats negative or non-finite word counts as no content (minimum 1)', () => {
    expect(estimateReadTimeMinutes(-100)).toBe(1);
    expect(estimateReadTimeMinutes(Number.NaN)).toBe(1);
    expect(estimateReadTimeMinutes(Number.POSITIVE_INFINITY)).toBe(1);
    expect(estimateReadTimeMinutes(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('is deterministic for the same inputs', () => {
    expect(estimateReadTimeMinutes(1234)).toBe(estimateReadTimeMinutes(1234));
    expect(estimateReadTimeMinutes(1234, { wordsPerMinute: 250 })).toBe(
      estimateReadTimeMinutes(1234, { wordsPerMinute: 250 }),
    );
  });
});

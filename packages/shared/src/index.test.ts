import { describe, it, expect } from 'vitest';
import {
  SHARED_PACKAGE_NAME,
  SOURCES,
  DIFFICULTIES,
  DEPTHS,
  FEED_EVENT_TYPES,
  DEFAULT_RANKING_WEIGHTS,
  ERROR_CODES,
  makeError,
  type RankingWeights,
} from './index.js';

describe('@lumina/shared', () => {
  it('exposes the package name', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@lumina/shared');
  });
});

describe('domain value sets', () => {
  it('lists the six supported sources', () => {
    expect([...SOURCES]).toEqual([
      'wikipedia',
      'medium',
      'hacker_news',
      'arxiv',
      'mit_news',
      'quanta',
    ]);
  });

  it('lists the three difficulty levels', () => {
    expect([...DIFFICULTIES]).toEqual(['introductory', 'intermediate', 'advanced']);
  });

  it('lists the three depth preferences', () => {
    expect([...DEPTHS]).toEqual(['quick', 'balanced', 'deep']);
  });

  it('lists the eleven feed event types from Requirement 12', () => {
    expect([...FEED_EVENT_TYPES]).toEqual([
      'impression',
      'dwell',
      'expand',
      'scroll_depth',
      'save',
      'unsave',
      'share',
      'link_out',
      'skip',
      'mute_topic',
      'session_end',
    ]);
  });
});

describe('default ranking weights (Requirement 9.4)', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RANKING_WEIGHTS).toEqual({
      relevance: 0.35,
      novelty: 0.2,
      quality: 0.2,
      recency: 0.15,
      diversity: 0.05,
      serendipity: 0.05,
    });
  });

  it('sums to 1.0', () => {
    const weights: RankingWeights = DEFAULT_RANKING_WEIGHTS;
    const sum =
      weights.relevance +
      weights.novelty +
      weights.quality +
      weights.recency +
      weights.diversity +
      weights.serendipity;
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe('error envelope', () => {
  it('exposes the stable error codes', () => {
    expect(ERROR_CODES).toEqual({
      VALIDATION_ERROR: 'VALIDATION_ERROR',
      AUTH_FAILED: 'AUTH_FAILED',
      NOT_FOUND: 'NOT_FOUND',
      CONFLICT: 'CONFLICT',
      FORBIDDEN: 'FORBIDDEN',
      RATE_LIMITED: 'RATE_LIMITED',
    });
  });

  it('builds an envelope without details when none provided', () => {
    const envelope = makeError(ERROR_CODES.NOT_FOUND, 'Article not found');
    expect(envelope).toEqual({
      error: { code: 'NOT_FOUND', message: 'Article not found' },
    });
    expect('details' in envelope.error).toBe(false);
  });

  it('includes details when provided', () => {
    const envelope = makeError(ERROR_CODES.VALIDATION_ERROR, 'Invalid field', {
      field: 'dailyGoal',
    });
    expect(envelope).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid field',
        details: { field: 'dailyGoal' },
      },
    });
  });
});

import { describe, it, expect } from 'vitest';
import { buildSearchFilters } from './filters.js';

// Verifies the conjunctive Typesense `filter_by` construction: each provided
// filter contributes a clause and the clauses are joined with `&&` so results
// match ALL filters (Requirement 20.7). Field names mirror the indexed
// `articles` schema.

describe('buildSearchFilters', () => {
  it('returns undefined when no filter is provided', () => {
    expect(buildSearchFilters()).toBeUndefined();
    expect(buildSearchFilters({})).toBeUndefined();
  });

  it('builds an exact source-facet clause', () => {
    expect(buildSearchFilters({ source: 'arxiv' })).toBe('source:=arxiv');
  });

  it('builds an exact topic-slug clause against topic_slugs', () => {
    expect(buildSearchFilters({ topic: 'physics' })).toBe(
      'topic_slugs:=physics',
    );
  });

  it('builds an inclusive read-time range with both bounds', () => {
    expect(buildSearchFilters({ readTime: { min: 3, max: 10 } })).toBe(
      'read_time_minutes:[3..10]',
    );
  });

  it('builds single-sided read-time clauses', () => {
    expect(buildSearchFilters({ readTime: { min: 5 } })).toBe(
      'read_time_minutes:>=5',
    );
    expect(buildSearchFilters({ readTime: { max: 15 } })).toBe(
      'read_time_minutes:<=15',
    );
  });

  it('builds an inclusive published_at date range', () => {
    expect(
      buildSearchFilters({ dateRange: { from: 1700000000, to: 1800000000 } }),
    ).toBe('published_at:[1700000000..1800000000]');
  });

  it('omits a clause for a range with no bound', () => {
    expect(buildSearchFilters({ readTime: {} })).toBeUndefined();
    expect(buildSearchFilters({ dateRange: {} })).toBeUndefined();
  });

  it('joins all provided filters conjunctively with &&', () => {
    const filterBy = buildSearchFilters({
      source: 'medium',
      topic: 'machine-learning',
      readTime: { min: 2, max: 8 },
      dateRange: { from: 1700000000, to: 1800000000 },
    });
    expect(filterBy).toBe(
      'source:=medium && topic_slugs:=machine-learning && ' +
        'read_time_minutes:[2..8] && published_at:[1700000000..1800000000]',
    );
  });

  it('combines a subset of filters conjunctively in field order', () => {
    expect(
      buildSearchFilters({ source: 'wikipedia', readTime: { min: 1 } }),
    ).toBe('source:=wikipedia && read_time_minutes:>=1');
  });
});

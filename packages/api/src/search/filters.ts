// Conjunctive Typesense `filter_by` construction (Requirement 20.7).
//
// PURE: builds a Typesense `filter_by` string from the optional source, topic,
// read-time, and date-range filters and performs no I/O, so the exact clause
// shape is exhaustively unit-testable. Every provided filter is combined with
// `&&` so results are restricted to articles matching ALL of them
// (Requirement 20.7).
//
// Field names are taken from the shared `ARTICLE_FIELD` source of truth in the
// Typesense module so the filter clauses never drift from the indexed schema.

import type { Source } from '@lumina/shared';
import { ARTICLE_FIELD } from '../typesense/index.js';

/**
 * An inclusive numeric range. At least one bound should be present for the
 * range to contribute a clause; an all-`undefined` range contributes nothing.
 */
export interface RangeFilter {
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
}

/**
 * An inclusive publication-date range expressed as unix epoch **seconds** to
 * match the indexed `published_at` field (see the Typesense `articles` schema).
 */
export interface DateRangeFilter {
  /** Inclusive lower bound as unix epoch seconds. */
  from?: number;
  /** Inclusive upper bound as unix epoch seconds. */
  to?: number;
}

/**
 * Optional search filters. Each provided filter narrows results conjunctively
 * (Requirement 20.7):
 * - `source`: exact provider match on the `source` facet.
 * - `topic`: a taxonomy slug matched against the `topic_slugs[]` facet.
 * - `readTime`: an inclusive `read_time_minutes` range.
 * - `dateRange`: an inclusive `published_at` range (epoch seconds).
 */
export interface SearchFilters {
  source?: Source;
  topic?: string;
  readTime?: RangeFilter;
  dateRange?: DateRangeFilter;
}

/**
 * Build an inclusive Typesense range clause for a numeric field, or `null` when
 * neither bound is present. Uses `[min..max]` when both bounds are given and the
 * single-sided `>=`/`<=` operators otherwise.
 */
function rangeClause(
  field: string,
  min: number | undefined,
  max: number | undefined,
): string | null {
  if (min !== undefined && max !== undefined) {
    return `${field}:[${min}..${max}]`;
  }
  if (min !== undefined) {
    return `${field}:>=${min}`;
  }
  if (max !== undefined) {
    return `${field}:<=${max}`;
  }
  return null;
}

/**
 * Construct a conjunctive Typesense `filter_by` string from the provided
 * filters, joining each clause with `&&` (Requirement 20.7). Filters that are
 * omitted — or ranges with no bound — contribute no clause. Returns `undefined`
 * when no filter applies so callers can omit `filter_by` entirely rather than
 * sending an empty string.
 *
 * The accepted `source` values are a fixed enum and `topic` values are URL-safe
 * taxonomy slugs, so the equality clauses need no escaping.
 */
export function buildSearchFilters(
  filters: SearchFilters = {},
): string | undefined {
  const clauses: string[] = [];

  if (filters.source !== undefined) {
    clauses.push(`${ARTICLE_FIELD.source}:=${filters.source}`);
  }

  if (filters.topic !== undefined) {
    clauses.push(`${ARTICLE_FIELD.topicSlugs}:=${filters.topic}`);
  }

  if (filters.readTime !== undefined) {
    const clause = rangeClause(
      ARTICLE_FIELD.readTimeMinutes,
      filters.readTime.min,
      filters.readTime.max,
    );
    if (clause !== null) clauses.push(clause);
  }

  if (filters.dateRange !== undefined) {
    const clause = rangeClause(
      ARTICLE_FIELD.publishedAt,
      filters.dateRange.from,
      filters.dateRange.to,
    );
    if (clause !== null) clauses.push(clause);
  }

  return clauses.length > 0 ? clauses.join(' && ') : undefined;
}

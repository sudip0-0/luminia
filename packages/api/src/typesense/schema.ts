// Typesense `articles` collection schema.
//
// Mirrors the "Typesense Collection (`articles`)" section of the design
// document. Full-text search is served by Typesense (Requirement 20) with
// typo-tolerant ranked relevance and faceted/range filters
// (Requirements 20.4, 20.7).
//
// Everything in this module is PURE: the schema and field definitions are
// plain data and the builder performs no I/O, so the exact field shape (types,
// facets, range indexes) is exhaustively unit-testable without a live
// Typesense server.

import type { CollectionCreateSchema, CollectionFieldSchema } from 'typesense';
import type { Source } from '@lumina/shared';

/** Name of the Typesense collection that indexes ingested articles. */
export const ARTICLES_COLLECTION_NAME = 'articles';

/**
 * Field names of the `articles` collection, declared once so the schema, the
 * document mapping, and any filter/search builders share a single source of
 * truth and never drift apart.
 */
export const ARTICLE_FIELD = {
  /** Reserved Typesense document identifier (the Article id). */
  id: 'id',
  /** Full-text searchable article title. */
  title: 'title',
  /** Full-text searchable 2-3 sentence summary. */
  summary: 'summary',
  /** Full-text searchable cleaned article body. */
  fullText: 'full_text',
  /** Faceted source provider (one of the six supported Sources). */
  source: 'source',
  /** Faceted taxonomy slugs associated with the article. */
  topicSlugs: 'topic_slugs',
  /** Range/facet-filterable whole-minute read time. */
  readTimeMinutes: 'read_time_minutes',
  /** Range-filterable / default-sort publication time (unix epoch seconds). */
  publishedAt: 'published_at',
} as const;

/**
 * A document as stored in the `articles` Typesense collection.
 *
 * `published_at` is a unix epoch in **seconds** (an `int64`) so it can be used
 * for range filtering and default descending-recency sorting; the domain
 * Article carries it as an ISO-8601 string (see {@link articleToDocument}).
 */
export interface ArticleDocument {
  id: string;
  title: string;
  summary: string;
  full_text: string;
  source: Source;
  topic_slugs: string[];
  read_time_minutes: number;
  published_at: number;
}

/**
 * Field definitions for the `articles` collection.
 *
 * - `title` / `summary` / `full_text` are full-text searchable strings; `infix`
 *   search is enabled so partial-token matches are possible.
 * - `source` and `topic_slugs[]` are facets for conjunctive filtering
 *   (Requirement 20.7).
 * - `read_time_minutes` is a numeric facet with a range index for read-time
 *   range filters.
 * - `published_at` is a numeric (int64) field with a range index, used both for
 *   date-range filters and as the default descending-recency sort.
 *
 * The reserved `id` field is supplied per-document and indexed automatically by
 * Typesense, so it is intentionally not declared here.
 */
export const ARTICLE_FIELDS: readonly CollectionFieldSchema[] = [
  { name: ARTICLE_FIELD.title, type: 'string', infix: true },
  { name: ARTICLE_FIELD.summary, type: 'string' },
  { name: ARTICLE_FIELD.fullText, type: 'string' },
  { name: ARTICLE_FIELD.source, type: 'string', facet: true },
  { name: ARTICLE_FIELD.topicSlugs, type: 'string[]', facet: true },
  {
    name: ARTICLE_FIELD.readTimeMinutes,
    type: 'int32',
    facet: true,
    sort: true,
    range_index: true,
  },
  {
    name: ARTICLE_FIELD.publishedAt,
    type: 'int64',
    sort: true,
    range_index: true,
  },
] as const;

/**
 * Builds the `articles` collection-create schema accepted by the Typesense
 * client. Returns a fresh object on each call (no shared mutable state) so
 * callers may safely augment it. Default sorting is by descending recency
 * (`published_at`).
 */
export function buildArticlesCollectionSchema(): CollectionCreateSchema {
  return {
    name: ARTICLES_COLLECTION_NAME,
    fields: ARTICLE_FIELDS.map((field) => ({ ...field })),
    default_sorting_field: ARTICLE_FIELD.publishedAt,
  };
}

// Pure mapping between the domain {@link Article} and the Typesense
// {@link ArticleDocument} stored in the `articles` collection.
//
// Kept separate from the client wrapper and free of I/O so the mapping logic
// (null-handling, slug projection, ISO-8601 -> epoch-seconds conversion) is
// directly unit-testable. The Ingestion_Pipeline indexes documents produced
// here when it stores an article (Requirement 20.4).

import type { Article } from '@lumina/shared';
import type { ArticleDocument } from './schema.js';

/**
 * Projects a domain {@link Article} into the flat {@link ArticleDocument}
 * indexed by Typesense.
 *
 * Mapping rules:
 * - `summary` / `full_text`: a `null` domain value (an unsummarized article or
 *   one without cleaned body text) is indexed as an empty string so the field
 *   stays a plain `string` and remains searchable without special-casing.
 * - `topic_slugs`: the association `topicId`s are projected directly; callers
 *   that resolve slugs separately can pass them via `topicSlugs`.
 * - `published_at`: the ISO-8601 timestamp is converted to whole unix epoch
 *   **seconds** for range filtering and default descending-recency sorting.
 *
 * @param article The domain article to index.
 * @param topicSlugs Optional explicit taxonomy slugs; when omitted the
 *   article's topic association ids are used.
 */
export function articleToDocument(
  article: Article,
  topicSlugs?: readonly string[]
): ArticleDocument {
  return {
    id: article.id,
    title: article.title,
    summary: article.summary ?? '',
    full_text: article.fullText ?? '',
    source: article.source,
    topic_slugs: topicSlugs
      ? [...topicSlugs]
      : article.topics.map((t) => t.topicId),
    read_time_minutes: article.readTimeMinutes,
    published_at: isoToEpochSeconds(article.publishedAt),
  };
}

/**
 * Converts an ISO-8601 timestamp to whole unix epoch seconds. Throws a
 * descriptive error on an unparseable timestamp so a malformed article never
 * silently indexes as epoch 0.
 */
export function isoToEpochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO-8601 timestamp: ${iso}`);
  }
  return Math.floor(ms / 1000);
}

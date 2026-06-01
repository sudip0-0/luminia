// Onboarding_Service — topic taxonomy (Requirement 3.1).
//
// `getTaxonomy` reads the full topic taxonomy via the topics repository and
// maps each row to the public taxonomy DTO: slug, label, parent reference,
// color, and icon name. It is intentionally decoupled from Fastify — it takes a
// {@link Queryable} dependency so it can be unit-tested with an in-memory
// FakeQueryable and reused by the route handler registered in a later task.
//
// The parent reference is exposed as the parent topic's *slug* (`parentSlug`)
// rather than the internal uuid, so the public endpoint never leaks database
// identifiers. Top-level topics have `parentSlug = null`.

import { type Queryable } from '../repositories/queryable.js';
import { listTopics } from '../repositories/topics.repository.js';

/**
 * A single taxonomy entry as returned by `GET /onboarding/topics`
 * (Requirement 3.1). Carries the public, slug-based shape — internal topic ids
 * and centroids are intentionally omitted.
 */
export interface TopicTaxonomyDto {
  /** Stable public identifier for the topic. */
  slug: string;
  /** Human-readable display label. */
  label: string;
  /** Slug of the parent topic, or `null` for a top-level topic. */
  parentSlug: string | null;
  /** Display color (e.g. a hex string). */
  color: string;
  /** Icon identifier rendered by the Mobile_App. */
  iconName: string;
}

/** Dependencies for the taxonomy service. */
export interface TaxonomyDeps {
  /** Database handle; a live pool or an in-memory fake in tests. */
  db: Queryable;
}

/**
 * Return the available topic taxonomy with slug, label, parent reference,
 * color, and icon name for each topic (Requirement 3.1). Topics are returned in
 * the repository's order (by slug ascending). A topic's `parentId` is resolved
 * to the parent's slug from the loaded set; an unresolved parent (which should
 * not occur given the foreign-key constraint) maps to `null`.
 */
export async function getTaxonomy(
  deps: TaxonomyDeps,
): Promise<TopicTaxonomyDto[]> {
  const topics = await listTopics(deps.db);
  const slugById = new Map(topics.map((topic) => [topic.id, topic.slug]));

  return topics.map((topic) => ({
    slug: topic.slug,
    label: topic.label,
    parentSlug:
      topic.parentId !== null ? (slugById.get(topic.parentId) ?? null) : null,
    color: topic.color,
    iconName: topic.iconName,
  }));
}

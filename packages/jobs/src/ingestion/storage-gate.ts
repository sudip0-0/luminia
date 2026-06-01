// Storage completeness gate — Ingestion_Pipeline storage step
// (Requirements 6.5, 7.5; Property 7).
//
// Before an Article reaches the stored state it must satisfy the completeness
// invariant: a non-empty URL, source, title, summary, and cleaned full text; a
// quality score >= 0.3; an embedding vector of exactly EMBEDDING_DIMENSIONS
// (1536) finite numbers; and a read time that is a whole number of minutes >= 1
// (Requirements 6.5, 6.6, 7.5). The {@link isStorable} predicate and
// {@link assertComplete} guard are PURE and total. The {@link storeArticle}
// orchestrator refuses storage unless the gate passes; on pass it persists the
// Article via an injected repository and indexes it into Typesense via an
// injected index. Both side-effecting collaborators are injected behind narrow
// interfaces so the orchestrator is testable without a database or a live
// Typesense server.
//
// Design references: Requirements 6.5, 7.5 and Property 7 ("For any article
// that reaches the stored state, it has a non-null URL, source, title, summary,
// cleaned full text, a quality score >= 0.3, an embedding vector of exactly
// 1536 dimensions, and a read time that is a whole number of minutes >= 1").

import { EMBEDDING_DIMENSIONS, SOURCES, type Source } from '@lumina/shared';
import { QUALITY_THRESHOLD } from './quality-scorer.js';
import { MIN_READ_TIME_MINUTES } from './read-time.js';

// Re-export the required vector width so callers of the storage gate reference
// it from a single source of truth (Requirement 7.5).
export { EMBEDDING_DIMENSIONS };

/**
 * The fields required for an Article to be permitted into the stored state
 * (Requirements 6.5, 7.5, Property 7). This is the narrow input the
 * completeness gate inspects; it intentionally omits server-assigned fields
 * (id, ingestion timestamp) that storage itself produces.
 */
export interface CompleteArticleInput {
  /** Canonical article URL. Must be a non-empty string. */
  url: string;
  /** One of the six supported content providers. */
  source: Source;
  /** Article title. Must be a non-empty string. */
  title: string;
  /** Summary produced by the Summarizer. Must be a non-empty string. */
  summary: string;
  /** Cleaned full body text. Must be a non-empty string. */
  fullText: string;
  /** Quality score in [0,1]; storage requires `>= QUALITY_THRESHOLD` (0.3). */
  qualityScore: number;
  /** Embedding vector; must have exactly {@link EMBEDDING_DIMENSIONS} finite numbers. */
  embedding: number[];
  /** Whole-minute read time; must be an integer `>= MIN_READ_TIME_MINUTES` (1). */
  readTimeMinutes: number;
}

/** Each field of {@link CompleteArticleInput} the gate can flag as missing/invalid. */
export type CompletenessField =
  | 'url'
  | 'source'
  | 'title'
  | 'summary'
  | 'fullText'
  | 'qualityScore'
  | 'embedding'
  | 'readTimeMinutes';

/** True iff `value` is a non-empty (post-trim) string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True iff `value` is one of the six supported {@link Source}s. */
function isValidSource(value: unknown): value is Source {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

/**
 * True iff `vector` is a usable embedding: an array of exactly
 * {@link EMBEDDING_DIMENSIONS} finite numbers (Requirement 7.5, Property 7).
 */
function isValidEmbedding(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Identify every field of `article` that fails the completeness invariant, in a
 * stable order. An empty array means the Article is storable. Pure and total —
 * accepts an arbitrary partial/unknown shape and never throws.
 */
export function findMissingFields(
  article: Partial<CompleteArticleInput> | null | undefined,
): CompletenessField[] {
  const missing: CompletenessField[] = [];
  if (article == null) {
    return [
      'url',
      'source',
      'title',
      'summary',
      'fullText',
      'qualityScore',
      'embedding',
      'readTimeMinutes',
    ];
  }

  if (!isNonEmptyString(article.url)) missing.push('url');
  if (!isValidSource(article.source)) missing.push('source');
  if (!isNonEmptyString(article.title)) missing.push('title');
  if (!isNonEmptyString(article.summary)) missing.push('summary');
  if (!isNonEmptyString(article.fullText)) missing.push('fullText');

  const quality = article.qualityScore;
  if (
    typeof quality !== 'number' ||
    !Number.isFinite(quality) ||
    quality < QUALITY_THRESHOLD
  ) {
    missing.push('qualityScore');
  }

  if (!isValidEmbedding(article.embedding)) missing.push('embedding');

  const readTime = article.readTimeMinutes;
  if (
    typeof readTime !== 'number' ||
    !Number.isInteger(readTime) ||
    readTime < MIN_READ_TIME_MINUTES
  ) {
    missing.push('readTimeMinutes');
  }

  return missing;
}

/**
 * The completeness gate. Returns `true` if and only if `article` has a
 * non-empty URL, a valid source, a non-empty title, summary, and cleaned full
 * text, a quality score `>= QUALITY_THRESHOLD` (0.3), an embedding of exactly
 * {@link EMBEDDING_DIMENSIONS} finite numbers, and a whole-minute read time
 * `>= MIN_READ_TIME_MINUTES` (1) (Requirements 6.5, 7.5, Property 7). Pure and
 * total.
 */
export function isStorable(
  article: Partial<CompleteArticleInput> | null | undefined,
): article is CompleteArticleInput {
  return findMissingFields(article).length === 0;
}

/** Error thrown by {@link assertComplete} when the completeness gate fails. */
export class IncompleteArticleError extends Error {
  constructor(public readonly missingFields: CompletenessField[]) {
    super(
      `Article is not storable; missing or invalid fields: ${missingFields.join(', ')}`,
    );
    this.name = 'IncompleteArticleError';
  }
}

/**
 * Assert that `article` satisfies the completeness invariant, narrowing it to
 * {@link CompleteArticleInput}. Throws {@link IncompleteArticleError} listing
 * the offending fields when the gate fails (Requirements 6.5, 7.5, Property 7).
 */
export function assertComplete(
  article: Partial<CompleteArticleInput> | null | undefined,
): asserts article is CompleteArticleInput {
  const missing = findMissingFields(article);
  if (missing.length > 0) {
    throw new IncompleteArticleError(missing);
  }
}

/**
 * Narrow persistence interface for a complete Article. Modeled on the real
 * articles repository's insert contract but kept injected so the orchestrator
 * runs without a database. Implementations persist the Article and return its
 * server-assigned id.
 */
export interface ArticleStore {
  /** Persist a complete Article and resolve with its stored id. */
  insertComplete(article: CompleteArticleInput): Promise<{ id: string }>;
}

/**
 * Narrow search-index interface. Modeled on the Typesense `ArticlesIndex`
 * conceptually but kept injected so the orchestrator runs without a live
 * Typesense server. Implementations index the stored Article for search.
 */
export interface ArticleSearchIndex {
  /** Index (create or replace) the stored Article for full-text search. */
  indexComplete(article: CompleteArticleInput & { id: string }): Promise<void>;
}

/** Collaborators injected into {@link storeArticle}. */
export interface StoreArticleDeps {
  /** Persists the complete Article (e.g. the PostgreSQL articles repository). */
  repository: ArticleStore;
  /** Indexes the stored Article for search (e.g. the Typesense articles index). */
  searchIndex: ArticleSearchIndex;
}

/** Article persisted and indexed successfully. */
export interface StoreArticleSuccess {
  status: 'stored';
  /** The server-assigned id of the stored Article. */
  id: string;
}

/**
 * Storage refused: the Article failed the completeness gate, so it was neither
 * persisted nor indexed (Requirements 6.5, 7.5, Property 7).
 */
export interface StoreArticleRejected {
  status: 'rejected';
  /** The fields that were missing or invalid. */
  missingFields: CompletenessField[];
}

/** Discriminated outcome of attempting to store an Article. */
export type StoreArticleResult = StoreArticleSuccess | StoreArticleRejected;

/**
 * Persist and index an Article only when it satisfies the completeness
 * invariant (Requirements 6.5, 7.5, Property 7).
 *
 * The orchestrator first runs the {@link isStorable} gate. When the gate fails
 * it short-circuits with a `rejected` result listing the offending fields and
 * performs no side effects — nothing is persisted or indexed. When the gate
 * passes it persists the Article through {@link StoreArticleDeps.repository},
 * then indexes the stored Article (with its assigned id) through
 * {@link StoreArticleDeps.searchIndex}, and returns a `stored` result with the
 * id. Persistence happens before indexing so the search index never references
 * an Article that was not persisted.
 */
export async function storeArticle(
  deps: StoreArticleDeps,
  article: Partial<CompleteArticleInput> | null | undefined,
): Promise<StoreArticleResult> {
  const missingFields = findMissingFields(article);
  if (missingFields.length > 0) {
    return { status: 'rejected', missingFields };
  }

  // The gate passed, so `article` satisfies CompleteArticleInput.
  const complete = article as CompleteArticleInput;

  const { id } = await deps.repository.insertComplete(complete);
  await deps.searchIndex.indexComplete({ ...complete, id });

  return { status: 'stored', id };
}

// Search_Service — full-text search over the `articles` Typesense collection.
//
// Validates the query (Requirements 20.4, 20.5), applies the source/topic/
// read-time/date-range filters conjunctively (Requirement 20.7), and returns
// matching documents by descending full-text relevance (Requirement 20.4) — an
// empty page on no match (Requirement 20.6).
//
// The service depends on the narrow {@link ArticleSearchClient} interface rather
// than a live Typesense client, so it is fully unit-testable with an in-memory
// fake and never opens a network connection. A production implementation wraps
// the `typesense` documents `search` API to satisfy this surface.

import {
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
  type Paginated,
} from '@lumina/shared';
import { ARTICLE_FIELD, type ArticleDocument } from '../typesense/index.js';
import { validateSearchQuery } from './query.js';
import { buildSearchFilters, type SearchFilters } from './filters.js';

/** Default number of matches returned per search page. */
export const SEARCH_PAGE_SIZE = 20;

/**
 * Comma-separated full-text fields the query is matched against, drawn from the
 * shared `ARTICLE_FIELD` source of truth so it tracks the indexed schema.
 */
export const SEARCH_QUERY_BY = [
  ARTICLE_FIELD.title,
  ARTICLE_FIELD.summary,
  ARTICLE_FIELD.fullText,
].join(',');

/**
 * Sort specification for descending full-text relevance (Requirement 20.4),
 * tie-broken by descending recency so equally-relevant matches are stable.
 */
export const SEARCH_SORT_BY = `_text_match:desc,${ARTICLE_FIELD.publishedAt}:desc`;

/** Parameters passed to the injected {@link ArticleSearchClient}. */
export interface SearchClientParams {
  /** The validated, trimmed query string. */
  q: string;
  /** Comma-separated full-text fields to search (see {@link SEARCH_QUERY_BY}). */
  query_by: string;
  /** Conjunctive `filter_by` clause; omitted when no filter applies. */
  filter_by?: string;
  /** Sort specification (see {@link SEARCH_SORT_BY}). */
  sort_by: string;
  /** 1-based page number. */
  page: number;
  /** Page size. */
  per_page: number;
}

/** A single search hit: the indexed document and its relevance score. */
export interface SearchHit {
  document: ArticleDocument;
  /** Typesense full-text relevance score; higher is more relevant. */
  text_match?: number;
}

/** The subset of a Typesense search response the service consumes. */
export interface SearchClientResponse {
  /** The page of hits in descending-relevance order (absent when none). */
  hits?: SearchHit[];
  /** Total number of matches across all pages. */
  found: number;
}

/**
 * The narrow search surface the service depends on. A live `typesense`
 * documents handle satisfies this; tests supply an in-memory fake.
 */
export interface ArticleSearchClient {
  search(params: SearchClientParams): Promise<SearchClientResponse>;
}

/** Dependencies injected into {@link search}. */
export interface SearchDeps {
  /** The search backend (a Typesense adapter in production, a fake in tests). */
  client: ArticleSearchClient;
  /** Page size override; defaults to {@link SEARCH_PAGE_SIZE}. */
  perPage?: number;
}

/** A single search request. */
export interface SearchRequest {
  /** The raw query string (validated before searching). */
  q: string;
  /** Optional conjunctive filters. */
  filters?: SearchFilters;
  /** Opaque next-page cursor from a previous response, or null/undefined. */
  cursor?: string | null;
}

/**
 * The discriminated result of a search: either a page of matching documents or
 * the uniform validation-error envelope (Requirement 20.5). A successful search
 * that matches nothing yields an empty page (Requirement 20.6).
 */
export type SearchResult =
  | { ok: true; results: Paginated<ArticleDocument> }
  | { ok: false; error: ApiErrorEnvelope };

/**
 * Encode a 1-based page number into an opaque cursor. Page 1 needs no cursor,
 * so only pages beyond the first are encoded.
 */
function encodePageCursor(page: number): string {
  return Buffer.from(`page:${page}`, 'utf8').toString('base64url');
}

/**
 * Decode an opaque page cursor back to a 1-based page number. Returns `null`
 * when the cursor is malformed so the caller can reject it.
 */
function decodePageCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^page:(\d+)$/.exec(decoded);
  if (!match) return null;
  const page = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

/** Build the uniform validation-error envelope (Requirement 20.5). */
function validationError(message: string): SearchResult {
  return { ok: false, error: makeError(ERROR_CODES.VALIDATION_ERROR, message) };
}

/**
 * Perform a full-text search.
 *
 * 1. Reject an empty, whitespace-only, or oversized query with a validation
 *    error WITHOUT querying the backend (Requirements 20.4, 20.5).
 * 2. Reject a malformed pagination cursor with a validation error.
 * 3. Otherwise query the injected client with the conjunctive `filter_by`
 *    clause and descending-relevance sort, returning the page of matching
 *    documents — empty when nothing matches (Requirements 20.6, 20.7).
 */
export async function search(
  deps: SearchDeps,
  request: SearchRequest,
): Promise<SearchResult> {
  const { q, filters, cursor } = request;

  // (1) Validate the query before doing any work; never search an invalid query.
  if (!validateSearchQuery(q)) {
    return validationError(
      'Query must be between 1 and 200 characters after trimming.',
    );
  }

  // (2) Resolve the requested page from the optional cursor.
  let page = 1;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    const decoded = decodePageCursor(cursor);
    if (decoded === null) {
      return validationError('Invalid pagination cursor.');
    }
    page = decoded;
  }

  const perPage = deps.perPage ?? SEARCH_PAGE_SIZE;

  // (3) Query the backend with conjunctive filters and descending-relevance sort.
  const filterBy = buildSearchFilters(filters);
  const params: SearchClientParams = {
    q: q.trim(),
    query_by: SEARCH_QUERY_BY,
    sort_by: SEARCH_SORT_BY,
    page,
    per_page: perPage,
  };
  if (filterBy !== undefined) {
    params.filter_by = filterBy;
  }

  const response = await deps.client.search(params);
  const items = (response.hits ?? []).map((hit) => hit.document);

  // A further page exists only when the total matched exceeds what we've paged
  // through so far. On no match this is an empty page with no next cursor.
  const hasMore = page * perPage < response.found;
  const nextCursor = hasMore ? encodePageCursor(page + 1) : null;

  return { ok: true, results: { items, nextCursor } };
}

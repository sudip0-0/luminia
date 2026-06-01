import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '@lumina/shared';
import type { ArticleDocument } from '../typesense/index.js';
import {
  SEARCH_PAGE_SIZE,
  SEARCH_QUERY_BY,
  SEARCH_SORT_BY,
  search,
  type ArticleSearchClient,
  type SearchClientParams,
  type SearchClientResponse,
} from './service.js';

// Verifies the Search_Service against an in-memory fake search client (no live
// Typesense): query validation gating (20.4, 20.5), conjunctive filter
// forwarding and descending-relevance sort (20.7, 20.4), an empty page on no
// match (20.6), and cursor pagination.

/**
 * In-memory {@link ArticleSearchClient} fake. Records the params it was called
 * with and returns a scripted response, so the service's gating and parameter
 * construction can be asserted without a live Typesense server.
 */
class FakeSearchClient implements ArticleSearchClient {
  calls: SearchClientParams[] = [];
  response: SearchClientResponse;

  constructor(response: SearchClientResponse = { hits: [], found: 0 }) {
    this.response = response;
  }

  async search(params: SearchClientParams): Promise<SearchClientResponse> {
    this.calls.push(params);
    return this.response;
  }
}

function doc(overrides: Partial<ArticleDocument> = {}): ArticleDocument {
  return {
    id: 'art-1',
    title: 'Title',
    summary: 'Summary.',
    full_text: 'Body.',
    source: 'wikipedia',
    topic_slugs: ['physics'],
    read_time_minutes: 5,
    published_at: 1700000000,
    ...overrides,
  };
}

describe('search — query validation gating', () => {
  it('rejects an empty query without calling the client', async () => {
    const client = new FakeSearchClient();
    const result = await search({ client }, { q: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a whitespace-only query without searching', async () => {
    const client = new FakeSearchClient();
    const result = await search({ client }, { q: '   ' });

    expect(result.ok).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it('rejects an oversized query (>200 chars) without searching', async () => {
    const client = new FakeSearchClient();
    const result = await search({ client }, { q: 'x'.repeat(201) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a malformed cursor without searching', async () => {
    const client = new FakeSearchClient();
    const result = await search(
      { client },
      { q: 'physics', cursor: 'not-a-valid-cursor!!' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
    expect(client.calls).toHaveLength(0);
  });
});

describe('search — querying the backend', () => {
  it('searches with descending-relevance sort and the trimmed query', async () => {
    const hit = doc({ id: 'a-1' });
    const client = new FakeSearchClient({
      hits: [{ document: hit, text_match: 99 }],
      found: 1,
    });

    const result = await search({ client }, { q: '  quantum  ' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toEqual([hit]);
      expect(result.results.nextCursor).toBeNull();
    }
    expect(client.calls).toHaveLength(1);
    const params = client.calls[0]!;
    expect(params.q).toBe('quantum');
    expect(params.query_by).toBe(SEARCH_QUERY_BY);
    expect(params.sort_by).toBe(SEARCH_SORT_BY);
    expect(params.sort_by).toContain('_text_match:desc');
    expect(params.page).toBe(1);
    expect(params.per_page).toBe(SEARCH_PAGE_SIZE);
    expect(params.filter_by).toBeUndefined();
  });

  it('forwards conjunctive filters to the client as filter_by', async () => {
    const client = new FakeSearchClient({ hits: [], found: 0 });

    await search(
      { client },
      {
        q: 'neural nets',
        filters: {
          source: 'arxiv',
          topic: 'ai',
          readTime: { min: 2, max: 10 },
        },
      },
    );

    const params = client.calls[0]!;
    expect(params.filter_by).toBe(
      'source:=arxiv && topic_slugs:=ai && read_time_minutes:[2..10]',
    );
  });

  it('returns an empty page when nothing matches', async () => {
    const client = new FakeSearchClient({ hits: [], found: 0 });

    const result = await search({ client }, { q: 'nonexistent topic' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items).toEqual([]);
      expect(result.results.nextCursor).toBeNull();
    }
  });

  it('preserves the client hit order (descending relevance)', async () => {
    const first = doc({ id: 'most-relevant' });
    const second = doc({ id: 'less-relevant' });
    const client = new FakeSearchClient({
      hits: [
        { document: first, text_match: 100 },
        { document: second, text_match: 10 },
      ],
      found: 2,
    });

    const result = await search({ client }, { q: 'physics' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.items.map((d) => d.id)).toEqual([
        'most-relevant',
        'less-relevant',
      ]);
    }
  });
});

describe('search — pagination', () => {
  it('emits a next cursor when more matches remain and follows it', async () => {
    const client = new FakeSearchClient({
      hits: Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
        ({ document: doc({ id: `a-${i}` }), text_match: 1 }),
      ),
      found: SEARCH_PAGE_SIZE * 2,
    });

    const first = await search({ client }, { q: 'physics' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.results.nextCursor).not.toBeNull();

    // Following the cursor requests the next page from the client.
    await search({ client }, { q: 'physics', cursor: first.results.nextCursor });
    expect(client.calls[1]!.page).toBe(2);
  });

  it('emits no next cursor on the final page', async () => {
    const client = new FakeSearchClient({
      hits: [{ document: doc(), text_match: 1 }],
      found: 1,
    });

    const result = await search({ client }, { q: 'physics' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.nextCursor).toBeNull();
    }
  });

  it('honours a custom page size via deps', async () => {
    const client = new FakeSearchClient({
      hits: [
        { document: doc({ id: 'a' }), text_match: 2 },
        { document: doc({ id: 'b' }), text_match: 1 },
      ],
      found: 5,
    });

    const result = await search({ client, perPage: 2 }, { q: 'physics' });

    expect(client.calls[0]!.per_page).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2 of 5 returned -> a further page remains.
      expect(result.results.nextCursor).not.toBeNull();
    }
  });
});

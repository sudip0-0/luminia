import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Client as TypesenseClient } from 'typesense';
import type { Article } from '@lumina/shared';
import {
  ArticlesIndex,
  typesenseAdapter,
  createTypesenseClient,
  ARTICLES_COLLECTION_NAME,
  type ArticleDocument,
} from '../typesense/index.js';
import {
  search,
  type ArticleSearchClient,
  type SearchClientParams,
  type SearchClientResponse,
} from './service.js';

// Integration test for Typesense indexing and search ordering (Task 20.4).
//
// Validates, end-to-end against a LIVE Typesense index:
//   (a) an article is indexed on store via `ArticlesIndex.indexArticle` after
//       `ensureCollection` creates the `articles` collection, and
//   (b) the Search_Service returns matches by DESCENDING full-text relevance
//       with the source/topic/read-time filters applied CONJUNCTIVELY
//       (Requirements 20.4, 20.7).
//
// LIVE-SERVER GATING
// ------------------
// A live Typesense server is NOT guaranteed in CI. This suite reads the
// connection from the environment:
//   - TYPESENSE_HOST      (e.g. "localhost")
//   - TYPESENSE_PORT      (e.g. "8108")
//   - TYPESENSE_API_KEY   (the admin/search API key)
//   - TYPESENSE_PROTOCOL  (optional, defaults to "http")
//
// When those variables are absent the entire suite is SKIPPED via
// `describe.skipIf`, so `vitest run` passes without a server. When they are
// present but the server cannot be reached, each test self-skips at runtime
// (a reachability probe in `beforeAll`) rather than failing. The test body is
// fully written and runs against a real index when one is available.
//
// To run locally:
//   docker run -p 8108:8108 typesense/typesense:... --api-key=xyz --data-dir=/tmp
//   TYPESENSE_HOST=localhost TYPESENSE_PORT=8108 TYPESENSE_API_KEY=xyz \
//     npm test -- typesense.integration

/** Connection settings for a live Typesense, or null when not configured. */
interface LiveConfig {
  host: string;
  port: number;
  protocol: string;
  apiKey: string;
}

/**
 * Read live-Typesense connection settings from the environment. Returns null
 * (so the suite is skipped) unless host, port, and API key are all present and
 * the port parses to a positive integer.
 */
function readLiveConfig(): LiveConfig | null {
  const host = process.env.TYPESENSE_HOST;
  const apiKey = process.env.TYPESENSE_API_KEY;
  const portRaw = process.env.TYPESENSE_PORT;
  if (!host || !apiKey || !portRaw) return null;
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    host,
    port,
    protocol: process.env.TYPESENSE_PROTOCOL ?? 'http',
    apiKey,
  };
}

const liveConfig = readLiveConfig();

/**
 * Wrap a live Typesense documents handle as the narrow {@link ArticleSearchClient}
 * the Search_Service depends on, projecting each hit's document and relevance
 * score into the service's response shape.
 */
function liveSearchClient(client: TypesenseClient): ArticleSearchClient {
  return {
    async search(params: SearchClientParams): Promise<SearchClientResponse> {
      const response = await client
        .collections<ArticleDocument>(ARTICLES_COLLECTION_NAME)
        .documents()
        .search({
          q: params.q,
          query_by: params.query_by,
          sort_by: params.sort_by,
          page: params.page,
          per_page: params.per_page,
          ...(params.filter_by !== undefined
            ? { filter_by: params.filter_by }
            : {}),
        });
      return {
        hits: (response.hits ?? []).map((hit) => ({
          document: hit.document,
          text_match: hit.text_match,
        })),
        found: response.found,
      };
    },
  };
}

/** Build a complete domain {@link Article} fixture with overridable fields. */
function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: `it-20-4-${randomUUID()}`,
    url: `https://example.com/${randomUUID()}`,
    source: 'wikipedia',
    title: 'Untitled',
    summary: 'A summary.',
    fullText: 'Body text.',
    embedding: null,
    qualityScore: 0.8,
    difficulty: 'intermediate',
    readTimeMinutes: 5,
    topics: [],
    publishedAt: '2024-01-15T12:00:00.000Z',
    ingestedAt: '2024-01-15T13:00:00.000Z',
    ...overrides,
  };
}

describe.skipIf(liveConfig === null)(
  'Typesense indexing and ordering (live integration)',
  () => {
    // A unique per-run token isolates this run's documents from any other data
    // already in the `articles` collection: it appears only in the seeded docs,
    // so the search query matches exactly our fixtures and the shared
    // `run:<token>` slug lets teardown delete precisely what we created.
    const runToken = `lum${randomUUID().replace(/-/g, '')}`;
    const queryToken = `qz${runToken}`;
    const runSlug = `run-${runToken}`;
    const aiSlug = `ai-${runToken}`;
    const bioSlug = `bio-${runToken}`;

    let client: TypesenseClient;
    let index: ArticlesIndex;
    let searchDeps: { client: ArticleSearchClient };
    let reachable = false;

    beforeAll(async () => {
      const cfg = liveConfig as LiveConfig;
      client = createTypesenseClient({
        apiKey: cfg.apiKey,
        nodes: [{ host: cfg.host, port: cfg.port, protocol: cfg.protocol }],
        connectionTimeoutSeconds: 2,
        numRetries: 0,
      });

      // Probe reachability; on any failure leave `reachable` false so each test
      // self-skips instead of failing when the configured server is down.
      try {
        const health = await client.health.retrieve();
        reachable = health.ok === true;
      } catch {
        reachable = false;
      }
      if (!reachable) return;

      index = new ArticlesIndex(typesenseAdapter(client));
      searchDeps = { client: liveSearchClient(client) };

      // (a) Indexing on store: ensure the collection exists, then index the
      // fixtures through ArticlesIndex exactly as the Ingestion_Pipeline would.
      await index.ensureCollection();

      // Relevance fixtures: the query token sits in the high-weight `title`
      // field for one doc and only in the low-weight `full_text` field for the
      // other, so descending `_text_match` must rank the title match first.
      await index.indexArticle(
        makeArticle({
          title: `${queryToken} in the title and body ${queryToken}`,
          summary: `Discussing ${queryToken}.`,
          fullText: `The body mentions ${queryToken} repeatedly.`,
        }),
        [runSlug, aiSlug, 'relevance-high'],
      );
      await index.indexArticle(
        makeArticle({
          title: 'An unrelated headline',
          summary: 'No token here.',
          fullText: `Only the body text references ${queryToken} once.`,
        }),
        [runSlug, aiSlug, 'relevance-low'],
      );

      // Conjunctive-filter fixtures: all share the query token in the title (so
      // all match the query) but differ by source / topic / read-time so only
      // the doc satisfying ALL filters should survive.
      await index.indexArticle(
        makeArticle({
          title: `Filter match ${queryToken}`,
          source: 'arxiv',
          readTimeMinutes: 5,
        }),
        [runSlug, aiSlug, 'filter-match'],
      );
      await index.indexArticle(
        makeArticle({
          title: `Wrong source ${queryToken}`,
          source: 'medium',
          readTimeMinutes: 5,
        }),
        [runSlug, aiSlug, 'filter-wrong-source'],
      );
      await index.indexArticle(
        makeArticle({
          title: `Wrong topic ${queryToken}`,
          source: 'arxiv',
          readTimeMinutes: 5,
        }),
        [runSlug, bioSlug, 'filter-wrong-topic'],
      );
      await index.indexArticle(
        makeArticle({
          title: `Wrong read time ${queryToken}`,
          source: 'arxiv',
          readTimeMinutes: 30,
        }),
        [runSlug, aiSlug, 'filter-wrong-readtime'],
      );
    });

    afterAll(async () => {
      // Remove only this run's documents; never drop the shared collection.
      if (!reachable || !client) return;
      try {
        await client
          .collections<ArticleDocument>(ARTICLES_COLLECTION_NAME)
          .documents()
          .delete({ filter_by: `topic_slugs:=${runSlug}` });
      } catch {
        // Best-effort cleanup; ignore teardown failures.
      }
    });

    it('indexes an article on store so it is retrievable from the live index', (ctx) => {
      if (!reachable) {
        ctx.skip();
        return;
      }
      // The documents were upserted in beforeAll via ArticlesIndex.indexArticle;
      // the following search assertions confirm they are retrievable. This case
      // additionally asserts the collection now exists.
      return (async () => {
        const exists = await client
          .collections(ARTICLES_COLLECTION_NAME)
          .exists();
        expect(exists).toBe(true);
      })();
    });

    it('returns matches by descending full-text relevance', (ctx) => {
      if (!reachable) {
        ctx.skip();
        return;
      }
      return (async () => {
        const result = await search(searchDeps, {
          q: queryToken,
          filters: { topic: runSlug },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const slugRank = (doc: ArticleDocument): string =>
          doc.topic_slugs.find((s) => s.startsWith('relevance-')) ?? '';
        const ranked = result.results.items
          .map(slugRank)
          .filter((s) => s.length > 0);

        // Both relevance fixtures match; the title match must precede the
        // full-text-only match under descending `_text_match` (Requirement 20.4).
        expect(ranked).toEqual(['relevance-high', 'relevance-low']);
      })();
    });

    it('restricts results to articles matching ALL filters conjunctively', (ctx) => {
      if (!reachable) {
        ctx.skip();
        return;
      }
      return (async () => {
        const result = await search(searchDeps, {
          q: queryToken,
          filters: {
            source: 'arxiv',
            topic: aiSlug,
            readTime: { min: 1, max: 10 },
          },
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Only the doc that is arxiv AND topic aiSlug AND read-time in [1,10]
        // survives all three conjunctive clauses (Requirement 20.7). The
        // wrong-source, wrong-topic, and wrong-read-time fixtures are excluded.
        const labels = result.results.items
          .map((d) => d.topic_slugs.find((s) => s.startsWith('filter-')) ?? '')
          .filter((s) => s.length > 0);

        expect(labels).toContain('filter-match');
        expect(labels).not.toContain('filter-wrong-source');
        expect(labels).not.toContain('filter-wrong-topic');
        expect(labels).not.toContain('filter-wrong-readtime');
      })();
    });

    it('returns an empty result set when a valid query matches nothing', (ctx) => {
      if (!reachable) {
        ctx.skip();
        return;
      }
      return (async () => {
        const result = await search(searchDeps, {
          q: `nomatch${runToken}`,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.results.items).toEqual([]);
        expect(result.results.nextCursor).toBeNull();
      })();
    });
  },
);

import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { QueryRow } from '../repositories/queryable.js';
import {
  createArticleDataAccess,
  getArticleDetail,
  getRelatedArticles,
  MAX_RELATED_ARTICLES,
  type ArticleDataAccess,
} from './detail.js';

// Verifies the Feed_Service article-detail / related-article service
// (Requirements 11.1-11.4, 20.1, 20.3) over a FakeQueryable, so the pgvector
// `<=>` neighbour query, the article read, and the topic reads are exercised
// without a live database:
//   - detail returns the full article (with topics) plus related (20.1)
//   - missing source article => NOT_FOUND, no partial detail (11.4, 20.2)
//   - related returns <=5 distinct articles excluding the source, ordered by
//     descending similarity (11.1, 11.2), and [] when none remain (11.3)
//   - related-query failure degrades the detail to no related set (20.3)

const VECTOR = '[0.1,0.2,0.3]';

/** A raw `article` row as returned by `pg`, with overridable columns. */
function articleRow(id: string, overrides: Record<string, unknown> = {}): QueryRow {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, '0'),
    source: 'wikipedia',
    title: `Title ${id}`,
    summary: `Summary ${id}.`,
    full_text: `Body ${id}.`,
    embedding: VECTOR,
    quality_score: '0.8',
    difficulty: 'intermediate',
    read_time_minutes: 7,
    summarization_status: 'summarized',
    published_at: new Date('2024-01-15T12:00:00.000Z'),
    ingested_at: new Date('2024-01-15T13:00:00.000Z'),
    ...overrides,
  };
}

/** A raw `article_topic` row. */
function topicRow(articleId: string, topicId: string, confidence: number): QueryRow {
  return { article_id: articleId, topic_id: topicId, confidence };
}

interface FakeDbOptions {
  /** Articles keyed by id, served by `findArticleById`. */
  articlesById?: Record<string, QueryRow>;
  /** Rows (in DB order) served by the pgvector `<=>` neighbour query. */
  neighbours?: QueryRow[];
  /** When set, the neighbour query throws this error (simulates DB failure). */
  neighbourError?: Error;
  /** `article_topic` rows served by both topic queries. */
  topics?: QueryRow[];
}

/**
 * Build a {@link FakeQueryable} that routes each repository SQL statement to
 * the appropriate canned rows by inspecting the (normalized) SQL, so call
 * ordering does not have to be hand-maintained.
 */
function makeDb(opts: FakeDbOptions = {}): FakeQueryable {
  return new FakeQueryable((sql, params) => {
    const n = normalizeSql(sql);
    if (n.includes('FROM article WHERE id =')) {
      const id = params[0] as string;
      const row = opts.articlesById?.[id];
      return { rows: row ? [row] : [] };
    }
    if (n.includes('<=> $1::vector')) {
      if (opts.neighbourError) throw opts.neighbourError;
      return { rows: opts.neighbours ?? [] };
    }
    if (n.includes('FROM article_topic WHERE article_id IN')) {
      const ids = params as string[];
      return { rows: (opts.topics ?? []).filter((t) => ids.includes(t.article_id as string)) };
    }
    if (n.includes('FROM article_topic WHERE article_id =')) {
      const id = params[0];
      return { rows: (opts.topics ?? []).filter((t) => t.article_id === id) };
    }
    return { rows: [] };
  });
}

describe('getArticleDetail', () => {
  it('returns the full article detail with topics and related articles (20.1)', async () => {
    const db = makeDb({
      articlesById: {
        src: articleRow('src'),
        r1: articleRow('r1'),
        r2: articleRow('r2'),
      },
      neighbours: [articleRow('r1'), articleRow('r2')],
      topics: [
        topicRow('src', 'physics', 0.9),
        topicRow('src', 'space', 0.4),
        topicRow('r1', 'physics', 0.7),
      ],
    });

    const result = await getArticleDetail(createArticleDataAccess(db), 'src');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.article.id).toBe('src');
    expect(result.detail.article.title).toBe('Title src');
    expect(result.detail.article.topics).toEqual([
      { topicId: 'physics', confidence: 0.9 },
      { topicId: 'space', confidence: 0.4 },
    ]);
    expect(result.detail.related.map((a) => a.id)).toEqual(['r1', 'r2']);
    // related articles carry their own topic associations
    const r1 = result.detail.related.find((a) => a.id === 'r1');
    expect(r1?.topics).toEqual([{ topicId: 'physics', confidence: 0.7 }]);
  });

  it('returns NOT_FOUND with no partial detail when the source article is missing (11.4, 20.2)', async () => {
    const db = makeDb({ articlesById: {} });

    const result = await getArticleDetail(createArticleDataAccess(db), 'missing');

    expect(result).toEqual({
      status: 'not-found',
      error: {
        error: {
          code: 'NOT_FOUND',
          message: 'Article not found',
          details: { articleId: 'missing' },
        },
      },
    });
  });

  it('returns the detail WITHOUT related articles when the related query fails (20.3)', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbourError: new Error('pgvector unavailable'),
      topics: [topicRow('src', 'physics', 0.9)],
    });

    const result = await getArticleDetail(createArticleDataAccess(db), 'src');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.article.id).toBe('src');
    expect(result.detail.article.topics).toEqual([{ topicId: 'physics', confidence: 0.9 }]);
    // Degraded gracefully: detail is present, related is empty.
    expect(result.detail.related).toEqual([]);
  });

  it('returns empty related (no neighbour query) when the source has no embedding', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src', { embedding: null }) },
      neighbours: [articleRow('r1')],
    });

    const result = await getArticleDetail(createArticleDataAccess(db), 'src');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.related).toEqual([]);
    // The pgvector neighbour query is never issued without a source embedding.
    expect(db.calls.some((c) => c.sql.includes('<=> $1::vector'))).toBe(false);
  });
});

describe('getRelatedArticles', () => {
  it('returns up to 5 distinct articles excluding the source, in similarity order (11.1, 11.2)', async () => {
    // Seven neighbours in DB order; the source and a duplicate are included to
    // exercise defensive exclusion/dedup. Expect the first five distinct
    // non-source ids, in order.
    const neighbours = [
      articleRow('a'),
      articleRow('src'), // source leaking through — must be excluded
      articleRow('b'),
      articleRow('b'), // duplicate — must be dropped
      articleRow('c'),
      articleRow('d'),
      articleRow('e'),
      articleRow('f'),
    ];
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbours,
    });

    const result = await getRelatedArticles(createArticleDataAccess(db), 'src');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.related.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.related.length).toBeLessThanOrEqual(MAX_RELATED_ARTICLES);
    expect(result.related.some((a) => a.id === 'src')).toBe(false);
  });

  it('returns all remaining when fewer than 5 candidates exist', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbours: [articleRow('a'), articleRow('b')],
    });

    const result = await getRelatedArticles(createArticleDataAccess(db), 'src');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.related.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('returns [] when no candidates remain (11.3)', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbours: [],
    });

    const result = await getRelatedArticles(createArticleDataAccess(db), 'src');

    expect(result).toEqual({ status: 'ok', related: [] });
  });

  it('returns NOT_FOUND when the source article does not exist (11.4)', async () => {
    const db = makeDb({ articlesById: {} });

    const result = await getRelatedArticles(createArticleDataAccess(db), 'missing');

    expect(result).toEqual({
      status: 'not-found',
      error: {
        error: {
          code: 'NOT_FOUND',
          message: 'Article not found',
          details: { articleId: 'missing' },
        },
      },
    });
  });

  it('queries neighbours with the source embedding, the source exclusion, and the cap', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbours: [articleRow('a')],
    });

    await getRelatedArticles(createArticleDataAccess(db), 'src');

    const neighbourCall = db.calls.find((c) => c.sql.includes('<=> $1::vector'));
    expect(neighbourCall).toBeDefined();
    expect(neighbourCall?.sql).toContain('a.id <> $2');
    // [vector, excludeArticleId, limit]
    expect(neighbourCall?.params).toEqual([VECTOR, 'src', MAX_RELATED_ARTICLES]);
  });

  it('does not suppress a failing neighbour query (caller decides) — contrast with detail (20.3)', async () => {
    const db = makeDb({
      articlesById: { src: articleRow('src') },
      neighbourError: new Error('pgvector unavailable'),
    });

    await expect(
      getRelatedArticles(createArticleDataAccess(db), 'src'),
    ).rejects.toThrow('pgvector unavailable');
  });
});

describe('createArticleDataAccess wiring', () => {
  it('satisfies the ArticleDataAccess interface', () => {
    const access: ArticleDataAccess = createArticleDataAccess(makeDb());
    expect(typeof access.getArticleById).toBe('function');
    expect(typeof access.getRelatedByEmbedding).toBe('function');
    expect(typeof access.getTopicsForArticle).toBe('function');
    expect(typeof access.getTopicsForArticles).toBe('function');
  });
});

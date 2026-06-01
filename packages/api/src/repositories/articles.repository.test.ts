import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from './fake-queryable.js';
import {
  articleExistsByUrlHash,
  findArticleById,
  findArticleByUrlHash,
  findArticlesByEmbeddingSimilarity,
  insertArticle,
  listArticleCandidates,
} from './articles.repository.js';

// Verifies the articles repository: complete-article insertion with embedding
// serialization (Requirements 6.5, 7.5), dedup lookups by url_hash
// (Requirements 6.1, 6.2), candidate listing (8.x), and pgvector neighbour
// queries (11.1).

const URL_HASH = 'a'.repeat(64);

function articleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'art-1',
    url: 'https://example.com/a',
    url_hash: URL_HASH,
    source: 'wikipedia',
    title: 'Title',
    summary: 'Summary.',
    full_text: 'Body.',
    embedding: '[1,2,3]',
    quality_score: '0.8',
    difficulty: 'intermediate',
    read_time_minutes: 7,
    summarization_status: 'summarized',
    published_at: new Date('2024-01-15T12:00:00.000Z'),
    ingested_at: new Date('2024-01-15T13:00:00.000Z'),
    ...overrides,
  };
}

describe('insertArticle', () => {
  it('inserts with a vector-cast embedding and maps the stored row', async () => {
    const db = new FakeQueryable([{ rows: [articleRow()] }]);
    const article = await insertArticle(db, {
      url: 'https://example.com/a',
      urlHash: URL_HASH,
      source: 'wikipedia',
      title: 'Title',
      summary: 'Summary.',
      fullText: 'Body.',
      embedding: [1, 2, 3],
      qualityScore: 0.8,
      difficulty: 'intermediate',
      readTimeMinutes: 7,
      summarizationStatus: 'summarized',
      publishedAt: '2024-01-15T12:00:00.000Z',
    });

    const { sql, params } = db.lastCall;
    expect(normalizeSql(sql)).toContain('INSERT INTO article');
    expect(sql).toContain('$7::vector');
    // embedding (param 7) is serialized to the pgvector literal
    expect(params[6]).toBe('[1,2,3]');
    expect(params[1]).toBe(URL_HASH);
    expect(article.embedding).toEqual([1, 2, 3]);
    expect(article.qualityScore).toBeCloseTo(0.8);
    expect(article.publishedAt).toBe('2024-01-15T12:00:00.000Z');
  });

  it('binds null embedding/summary/fulltext when omitted', async () => {
    const db = new FakeQueryable([
      { rows: [articleRow({ embedding: null, summary: null, full_text: null, summarization_status: 'pending' })] },
    ]);
    const article = await insertArticle(db, {
      url: 'https://example.com/b',
      urlHash: 'b'.repeat(64),
      source: 'arxiv',
      title: 'T',
      qualityScore: 0.5,
      readTimeMinutes: 1,
      publishedAt: '2024-02-01T00:00:00.000Z',
    });
    const { params } = db.lastCall;
    expect(params[4]).toBeNull(); // summary
    expect(params[5]).toBeNull(); // full_text
    expect(params[6]).toBeNull(); // embedding
    expect(params[10]).toBe('pending'); // default status
    expect(article.embedding).toBeNull();
    expect(article.summary).toBeNull();
  });
});

describe('findArticleByUrlHash / articleExistsByUrlHash', () => {
  it('looks up by url_hash with a single param', async () => {
    const db = new FakeQueryable([{ rows: [articleRow()] }]);
    const article = await findArticleByUrlHash(db, URL_HASH);
    expect(db.lastCall.sql).toContain('WHERE url_hash = $1');
    expect(db.lastCall.params).toEqual([URL_HASH]);
    expect(article?.urlHash).toBe(URL_HASH);
  });

  it('returns boolean existence and null for missing id', async () => {
    const exists = new FakeQueryable([{ rows: [{ '?column?': 1 }] }]);
    expect(await articleExistsByUrlHash(exists, URL_HASH)).toBe(true);
    const missing = new FakeQueryable([{ rows: [] }]);
    expect(await articleExistsByUrlHash(missing, URL_HASH)).toBe(false);
    const none = new FakeQueryable([{ rows: [] }]);
    expect(await findArticleById(none, 'x')).toBeNull();
  });
});

describe('listArticleCandidates', () => {
  it('applies no filters with just a LIMIT param', async () => {
    const db = new FakeQueryable([{ rows: [articleRow()] }]);
    await listArticleCandidates(db);
    const { sql, params } = db.lastCall;
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY a.published_at DESC');
    expect(params).toEqual([100]); // default limit
  });

  it('composes source, topic, publishedAfter, and exclusion filters with sequential placeholders', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await listArticleCandidates(db, {
      source: 'medium',
      topicId: 't-1',
      publishedAfter: '2024-01-01T00:00:00.000Z',
      excludeArticleIds: ['x', 'y'],
      limit: 20,
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('a.source = $1');
    expect(sql).toContain('at.topic_id = $2');
    expect(sql).toContain('a.published_at >= $3');
    expect(sql).toContain('a.id NOT IN ($4, $5)');
    expect(sql).toContain('LIMIT $6');
    expect(params).toEqual([
      'medium',
      't-1',
      '2024-01-01T00:00:00.000Z',
      'x',
      'y',
      20,
    ]);
  });
});

describe('findArticlesByEmbeddingSimilarity', () => {
  it('orders by cosine distance, excludes the source, and parameterizes the vector', async () => {
    const db = new FakeQueryable([{ rows: [articleRow()] }]);
    await findArticlesByEmbeddingSimilarity(db, [0.1, 0.2], {
      excludeArticleId: 'art-1',
      limit: 5,
    });
    const { sql, params } = db.lastCall;
    expect(sql).toContain('a.embedding <=> $1::vector ASC');
    expect(sql).toContain('a.id <> $2');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['[0.1,0.2]', 'art-1', 5]);
  });

  it('omits the exclusion clause when no source id is given', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await findArticlesByEmbeddingSimilarity(db, [1]);
    const { sql, params } = db.lastCall;
    expect(sql).not.toContain('<>');
    expect(params).toEqual(['[1]', 5]);
  });
});

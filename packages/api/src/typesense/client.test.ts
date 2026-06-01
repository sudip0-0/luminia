import { describe, it, expect, beforeEach } from 'vitest';
import { Errors } from 'typesense';
import type { CollectionCreateSchema } from 'typesense';
import type { Article } from '@lumina/shared';
import { ArticlesIndex, type TypesenseLike } from './client.js';
import { ARTICLES_COLLECTION_NAME, type ArticleDocument } from './schema.js';

// Verifies the ArticlesIndex wrapper (ensure-collection idempotency and
// document indexing) against an in-memory fake, with no live Typesense server
// (Requirements 20.4, 20.7).

/** In-memory {@link TypesenseLike} fake recording collections and documents. */
class FakeTypesense implements TypesenseLike {
  readonly collections = new Map<string, CollectionCreateSchema>();
  readonly documents = new Map<string, Map<string, ArticleDocument>>();
  createCalls = 0;
  /** When set, the next createCollection call throws this error. */
  failNextCreateWith: Error | null = null;

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
  }

  async createCollection(schema: CollectionCreateSchema): Promise<void> {
    this.createCalls += 1;
    if (this.failNextCreateWith) {
      const err = this.failNextCreateWith;
      this.failNextCreateWith = null;
      throw err;
    }
    this.collections.set(schema.name, schema);
    if (!this.documents.has(schema.name)) {
      this.documents.set(schema.name, new Map());
    }
  }

  async upsertDocument(
    collection: string,
    document: ArticleDocument
  ): Promise<void> {
    const docs = this.documents.get(collection) ?? new Map();
    docs.set(document.id, document);
    this.documents.set(collection, docs);
  }

  async importDocuments(
    collection: string,
    documents: ArticleDocument[]
  ): Promise<void> {
    for (const doc of documents) {
      await this.upsertDocument(collection, doc);
    }
  }
}

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: 'art-1',
    url: 'https://example.com/a',
    source: 'wikipedia',
    title: 'Title',
    summary: 'Summary.',
    fullText: 'Body.',
    embedding: null,
    qualityScore: 0.8,
    difficulty: 'intermediate',
    readTimeMinutes: 5,
    topics: [{ topicId: 'physics', confidence: 0.9 }],
    publishedAt: '2024-01-15T12:00:00.000Z',
    ingestedAt: '2024-01-15T13:00:00.000Z',
    ...overrides,
  };
}

describe('ArticlesIndex.ensureCollection', () => {
  let fake: FakeTypesense;
  let index: ArticlesIndex;

  beforeEach(() => {
    fake = new FakeTypesense();
    index = new ArticlesIndex(fake);
  });

  it('creates the collection when absent and reports creation', async () => {
    const created = await index.ensureCollection();
    expect(created).toBe(true);
    expect(fake.collections.has(ARTICLES_COLLECTION_NAME)).toBe(true);
    expect(fake.collections.get(ARTICLES_COLLECTION_NAME)?.name).toBe(
      ARTICLES_COLLECTION_NAME
    );
  });

  it('is idempotent: a second call does not recreate the collection', async () => {
    await index.ensureCollection();
    const createdAgain = await index.ensureCollection();
    expect(createdAgain).toBe(false);
    expect(fake.createCalls).toBe(1);
  });

  it('treats a concurrent ObjectAlreadyExists as already-existing', async () => {
    fake.failNextCreateWith = new Errors.ObjectAlreadyExists(
      'collection already exists'
    );
    const created = await index.ensureCollection();
    expect(created).toBe(false);
  });

  it('propagates unexpected errors from createCollection', async () => {
    fake.failNextCreateWith = new Errors.ServerError('boom');
    await expect(index.ensureCollection()).rejects.toThrow('boom');
  });
});

describe('ArticlesIndex indexing', () => {
  let fake: FakeTypesense;
  let index: ArticlesIndex;

  beforeEach(async () => {
    fake = new FakeTypesense();
    index = new ArticlesIndex(fake);
    await index.ensureCollection();
  });

  it('indexes a single article as a mapped document', async () => {
    await index.indexArticle(article({ id: 'a-42', title: 'Hello' }));
    const stored = fake.documents.get(ARTICLES_COLLECTION_NAME)?.get('a-42');
    expect(stored?.title).toBe('Hello');
    expect(stored?.source).toBe('wikipedia');
    expect(stored?.topic_slugs).toEqual(['physics']);
  });

  it('upserts: re-indexing the same id replaces the document', async () => {
    await index.indexArticle(article({ id: 'a-1', title: 'First' }));
    await index.indexArticle(article({ id: 'a-1', title: 'Second' }));
    const docs = fake.documents.get(ARTICLES_COLLECTION_NAME)!;
    expect(docs.size).toBe(1);
    expect(docs.get('a-1')?.title).toBe('Second');
  });

  it('passes explicit topic slugs through to the indexed document', async () => {
    await index.indexArticle(article({ id: 'a-7' }), ['astro', 'cosmos']);
    const stored = fake.documents.get(ARTICLES_COLLECTION_NAME)?.get('a-7');
    expect(stored?.topic_slugs).toEqual(['astro', 'cosmos']);
  });

  it('batch-indexes many articles', async () => {
    await index.indexArticles([
      article({ id: 'b-1' }),
      article({ id: 'b-2' }),
      article({ id: 'b-3' }),
    ]);
    expect(fake.documents.get(ARTICLES_COLLECTION_NAME)?.size).toBe(3);
  });

  it('no-ops a batch index of zero articles', async () => {
    await index.indexArticles([]);
    expect(fake.documents.get(ARTICLES_COLLECTION_NAME)?.size).toBe(0);
  });

  it('indexes a pre-built document directly', async () => {
    const doc: ArticleDocument = {
      id: 'd-1',
      title: 'Direct',
      summary: '',
      full_text: '',
      source: 'arxiv',
      topic_slugs: [],
      read_time_minutes: 3,
      published_at: 1700000000,
    };
    await index.indexDocument(doc);
    expect(fake.documents.get(ARTICLES_COLLECTION_NAME)?.get('d-1')).toEqual(
      doc
    );
  });
});

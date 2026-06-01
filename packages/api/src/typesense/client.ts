// Typesense client wrapper for the `articles` collection.
//
// The Ingestion_Pipeline keeps the search index in sync by ensuring the
// collection exists and upserting article documents on store
// (Requirements 20.4, 20.7).
//
// The wrapper depends on the narrow {@link TypesenseLike} interface rather than
// on the `typesense` client directly. A live client is wrapped via
// {@link typesenseAdapter}; tests supply an in-memory fake so the
// ensure-collection and document-mapping logic can be verified without a live
// Typesense server.

import { Client as TypesenseClient, Errors } from 'typesense';
import type {
  CollectionCreateSchema,
  ConfigurationOptions,
} from 'typesense';
import type { Article } from '@lumina/shared';
import {
  ARTICLES_COLLECTION_NAME,
  buildArticlesCollectionSchema,
  type ArticleDocument,
} from './schema.js';
import { articleToDocument } from './document.js';

/**
 * The minimal surface of the Typesense client used by {@link ArticlesIndex}.
 * A live `typesense` client satisfies this via {@link typesenseAdapter}; tests
 * provide an in-memory fake. Keeping the surface narrow makes the wrapper
 * trivially mockable and keeps the production adapter a thin pass-through.
 */
export interface TypesenseLike {
  /** Whether a collection with the given name already exists. */
  collectionExists(name: string): Promise<boolean>;
  /** Create a collection from the given schema. */
  createCollection(schema: CollectionCreateSchema): Promise<void>;
  /** Create or replace a single document in the named collection. */
  upsertDocument(collection: string, document: ArticleDocument): Promise<void>;
  /** Create or replace many documents in the named collection. */
  importDocuments(
    collection: string,
    documents: ArticleDocument[]
  ): Promise<void>;
}

/**
 * Adapts a live `typesense` {@link TypesenseClient} to {@link TypesenseLike}.
 * Detects an already-existing collection via the client's `exists()` helper.
 */
export function typesenseAdapter(client: TypesenseClient): TypesenseLike {
  return {
    async collectionExists(name) {
      return client.collections(name).exists();
    },
    async createCollection(schema) {
      await client.collections().create(schema);
    },
    async upsertDocument(collection, document) {
      await client
        .collections<ArticleDocument>(collection)
        .documents()
        .upsert(document);
    },
    async importDocuments(collection, documents) {
      if (documents.length === 0) return;
      await client
        .collections<ArticleDocument>(collection)
        .documents()
        .import(documents, { action: 'upsert' });
    },
  };
}

/** Creates a live `typesense` client from connection options. */
export function createTypesenseClient(
  options: ConfigurationOptions
): TypesenseClient {
  return new TypesenseClient(options);
}

/**
 * Thin, typed wrapper over the `articles` Typesense collection. Provides
 * helpers to ensure the collection exists and to index/upsert article
 * documents, translating domain {@link Article}s through {@link articleToDocument}.
 */
export class ArticlesIndex {
  constructor(private readonly client: TypesenseLike) {}

  /**
   * Ensure the `articles` collection exists, creating it from
   * {@link buildArticlesCollectionSchema} when absent. Idempotent: returns
   * `true` when the collection was created and `false` when it already existed.
   * A concurrent creation (Typesense `ObjectAlreadyExists`) is treated as
   * already-existing rather than an error.
   */
  async ensureCollection(): Promise<boolean> {
    if (await this.client.collectionExists(ARTICLES_COLLECTION_NAME)) {
      return false;
    }
    try {
      await this.client.createCollection(buildArticlesCollectionSchema());
      return true;
    } catch (err) {
      if (err instanceof Errors.ObjectAlreadyExists) {
        return false;
      }
      throw err;
    }
  }

  /** Index (create or replace) a single article in the search collection. */
  async indexArticle(
    article: Article,
    topicSlugs?: readonly string[]
  ): Promise<void> {
    await this.client.upsertDocument(
      ARTICLES_COLLECTION_NAME,
      articleToDocument(article, topicSlugs)
    );
  }

  /** Index (create or replace) many articles in a single batch. */
  async indexArticles(articles: readonly Article[]): Promise<void> {
    const documents = articles.map((article) => articleToDocument(article));
    await this.client.importDocuments(ARTICLES_COLLECTION_NAME, documents);
  }

  /** Index a pre-built document directly (escape hatch for callers that map). */
  async indexDocument(document: ArticleDocument): Promise<void> {
    await this.client.upsertDocument(ARTICLES_COLLECTION_NAME, document);
  }
}

/** Build an {@link ArticlesIndex} backed by a live `typesense` client. */
export function createArticlesIndex(
  options: ConfigurationOptions
): ArticlesIndex {
  return new ArticlesIndex(typesenseAdapter(createTypesenseClient(options)));
}

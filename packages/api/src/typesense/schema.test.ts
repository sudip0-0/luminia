import { describe, it, expect } from 'vitest';
import {
  ARTICLES_COLLECTION_NAME,
  ARTICLE_FIELD,
  ARTICLE_FIELDS,
  buildArticlesCollectionSchema,
} from './schema.js';

// Verifies the `articles` collection schema shape against the design's
// "Typesense Collection (`articles`)" section without a live Typesense server
// (Requirements 20.4, 20.7).

describe('articles collection schema', () => {
  const byName = new Map(ARTICLE_FIELDS.map((f) => [f.name, f]));

  it('is named "articles"', () => {
    expect(ARTICLES_COLLECTION_NAME).toBe('articles');
    expect(buildArticlesCollectionSchema().name).toBe('articles');
  });

  it('defines exactly the design-specified indexed fields', () => {
    // `id` is the reserved Typesense document id and is indexed implicitly,
    // so it is not declared in the field list.
    expect([...byName.keys()].sort()).toEqual(
      [
        'full_text',
        'published_at',
        'read_time_minutes',
        'source',
        'summary',
        'title',
        'topic_slugs',
      ].sort()
    );
  });

  it('makes title, summary, and full_text full-text searchable strings', () => {
    for (const name of [
      ARTICLE_FIELD.title,
      ARTICLE_FIELD.summary,
      ARTICLE_FIELD.fullText,
    ]) {
      expect(byName.get(name)?.type).toBe('string');
      // Full-text fields are not facets.
      expect(byName.get(name)?.facet ?? false).toBe(false);
    }
  });

  it('declares source as a faceted string', () => {
    const source = byName.get(ARTICLE_FIELD.source);
    expect(source?.type).toBe('string');
    expect(source?.facet).toBe(true);
  });

  it('declares topic_slugs as a faceted string array', () => {
    const topics = byName.get(ARTICLE_FIELD.topicSlugs);
    expect(topics?.type).toBe('string[]');
    expect(topics?.facet).toBe(true);
  });

  it('declares read_time_minutes as a numeric range/facet field', () => {
    const rt = byName.get(ARTICLE_FIELD.readTimeMinutes);
    expect(rt?.type).toBe('int32');
    expect(rt?.facet).toBe(true);
    expect(rt?.range_index).toBe(true);
  });

  it('declares published_at as a numeric range field used for default sorting', () => {
    const published = byName.get(ARTICLE_FIELD.publishedAt);
    expect(published?.type).toBe('int64');
    expect(published?.range_index).toBe(true);
    expect(published?.sort).toBe(true);
    expect(buildArticlesCollectionSchema().default_sorting_field).toBe(
      'published_at'
    );
  });

  it('returns a fresh, independent schema object on each call', () => {
    const a = buildArticlesCollectionSchema();
    const b = buildArticlesCollectionSchema();
    expect(a).not.toBe(b);
    expect(a.fields).not.toBe(b.fields);
    // Mutating one copy must not affect the canonical field list or other copies.
    a.fields!.push({ name: 'injected', type: 'string' });
    expect(b.fields).toHaveLength(ARTICLE_FIELDS.length);
    expect(ARTICLE_FIELDS).toHaveLength(7);
  });
});

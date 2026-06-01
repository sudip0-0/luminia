import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SOURCES, type Article } from '@lumina/shared';
import { articleToDocument, isoToEpochSeconds } from './document.js';

// Verifies the pure Article -> ArticleDocument mapping used to keep the
// Typesense index in sync on store (Requirement 20.4).

function baseArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'art-1',
    url: 'https://example.com/a',
    source: 'wikipedia',
    title: 'A Title',
    summary: 'A short summary.',
    fullText: 'The cleaned full body text.',
    embedding: null,
    qualityScore: 0.8,
    difficulty: 'intermediate',
    readTimeMinutes: 7,
    topics: [
      { topicId: 'physics', confidence: 0.9 },
      { topicId: 'space', confidence: 0.4 },
    ],
    publishedAt: '2024-01-15T12:00:00.000Z',
    ingestedAt: '2024-01-15T13:00:00.000Z',
    ...overrides,
  };
}

describe('articleToDocument', () => {
  it('maps a fully populated article to a flat document', () => {
    const doc = articleToDocument(baseArticle());
    expect(doc).toEqual({
      id: 'art-1',
      title: 'A Title',
      summary: 'A short summary.',
      full_text: 'The cleaned full body text.',
      source: 'wikipedia',
      topic_slugs: ['physics', 'space'],
      read_time_minutes: 7,
      published_at: Math.floor(Date.parse('2024-01-15T12:00:00.000Z') / 1000),
    });
  });

  it('coerces null summary and fullText to empty strings', () => {
    const doc = articleToDocument(
      baseArticle({ summary: null, fullText: null })
    );
    expect(doc.summary).toBe('');
    expect(doc.full_text).toBe('');
  });

  it('projects topic association ids into topic_slugs by default', () => {
    const doc = articleToDocument(baseArticle());
    expect(doc.topic_slugs).toEqual(['physics', 'space']);
  });

  it('prefers explicitly supplied topic slugs over association ids', () => {
    const doc = articleToDocument(baseArticle(), ['astrophysics', 'cosmos']);
    expect(doc.topic_slugs).toEqual(['astrophysics', 'cosmos']);
  });

  it('handles an article with no topics as an empty slug array', () => {
    const doc = articleToDocument(baseArticle({ topics: [] }));
    expect(doc.topic_slugs).toEqual([]);
  });

  it('converts published_at from ISO-8601 to whole epoch seconds', () => {
    const doc = articleToDocument(
      baseArticle({ publishedAt: '2020-06-01T00:00:00.000Z' })
    );
    expect(doc.published_at).toBe(1590969600);
  });

  it('does not alias the source article topics array', () => {
    const article = baseArticle();
    const doc = articleToDocument(article);
    article.topics.push({ topicId: 'leaked', confidence: 1 });
    expect(doc.topic_slugs).toEqual(['physics', 'space']);
  });

  // Property: the document always has plain (non-null) string body fields, a
  // valid source, integer epoch seconds, and slug count equal to the article's
  // topic count, for any generated article.
  it('produces a well-formed document for any article (property)', () => {
    const arb = fc.record({
      id: fc.string({ minLength: 1 }),
      title: fc.string(),
      summary: fc.option(fc.string(), { nil: null }),
      fullText: fc.option(fc.string(), { nil: null }),
      source: fc.constantFrom(...SOURCES),
      readTimeMinutes: fc.integer({ min: 1, max: 120 }),
      topics: fc.array(
        fc.record({
          topicId: fc.string({ minLength: 1 }),
          confidence: fc.float({ min: 0, max: 1, noNaN: true }),
        })
      ),
      publishedAt: fc
        .date({ min: new Date('1970-01-01T00:00:00Z'), noInvalidDate: true })
        .map((d) => d.toISOString()),
    });

    fc.assert(
      fc.property(arb, (partial) => {
        const doc = articleToDocument(baseArticle(partial));
        expect(typeof doc.summary).toBe('string');
        expect(typeof doc.full_text).toBe('string');
        expect(SOURCES).toContain(doc.source);
        expect(Number.isInteger(doc.published_at)).toBe(true);
        expect(doc.topic_slugs).toHaveLength(partial.topics.length);
        expect(doc.read_time_minutes).toBe(partial.readTimeMinutes);
        expect(doc.id).toBe(partial.id);
      }),
      { numRuns: 100 }
    );
  });
});

describe('isoToEpochSeconds', () => {
  it('floors to whole seconds', () => {
    expect(isoToEpochSeconds('2024-01-01T00:00:00.999Z')).toBe(
      Math.floor(Date.parse('2024-01-01T00:00:00.999Z') / 1000)
    );
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => isoToEpochSeconds('not-a-date')).toThrow(/Invalid ISO-8601/);
  });
});

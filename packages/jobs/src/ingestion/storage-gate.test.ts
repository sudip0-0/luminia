import { describe, it, expect, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@lumina/shared';
import {
  isStorable,
  assertComplete,
  findMissingFields,
  storeArticle,
  IncompleteArticleError,
  type CompleteArticleInput,
  type ArticleStore,
  type ArticleSearchIndex,
  type StoreArticleDeps,
} from './storage-gate.js';

/** A valid 1536-dimension embedding of finite numbers. */
function validEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_unused, i) => (i % 7) * 0.01);
}

/** A complete, storable article; override individual fields per test. */
function completeArticle(
  overrides: Partial<CompleteArticleInput> = {},
): CompleteArticleInput {
  return {
    url: 'https://example.com/articles/quantum-entanglement',
    source: 'quanta',
    title: 'Quantum Entanglement Explained',
    summary: 'A clear walkthrough of entanglement. It avoids hype. It is accurate.',
    fullText: 'The cleaned full body text of the article goes here, at length.',
    qualityScore: 0.75,
    embedding: validEmbedding(),
    readTimeMinutes: 6,
    ...overrides,
  };
}

describe('isStorable (completeness gate)', () => {
  it('accepts a complete article', () => {
    expect(isStorable(completeArticle())).toBe(true);
    expect(findMissingFields(completeArticle())).toEqual([]);
  });

  it('accepts the boundary values: quality exactly 0.3 and read time exactly 1', () => {
    expect(isStorable(completeArticle({ qualityScore: 0.3, readTimeMinutes: 1 }))).toBe(
      true,
    );
  });

  it('rejects a null or undefined article', () => {
    expect(isStorable(null)).toBe(false);
    expect(isStorable(undefined)).toBe(false);
  });

  it('rejects a missing or empty URL', () => {
    expect(isStorable(completeArticle({ url: '' }))).toBe(false);
    expect(isStorable(completeArticle({ url: '   ' }))).toBe(false);
    expect(findMissingFields(completeArticle({ url: '' }))).toContain('url');
  });

  it('rejects an invalid source', () => {
    expect(isStorable(completeArticle({ source: 'myspace' as never }))).toBe(false);
    expect(findMissingFields(completeArticle({ source: 'myspace' as never }))).toContain(
      'source',
    );
  });

  it('rejects a missing or empty title', () => {
    expect(isStorable(completeArticle({ title: '' }))).toBe(false);
    expect(isStorable(completeArticle({ title: '   ' }))).toBe(false);
  });

  it('rejects a missing or empty summary', () => {
    expect(isStorable(completeArticle({ summary: '' }))).toBe(false);
    expect(findMissingFields(completeArticle({ summary: '' }))).toContain('summary');
  });

  it('rejects missing or empty cleaned full text', () => {
    expect(isStorable(completeArticle({ fullText: '' }))).toBe(false);
    expect(findMissingFields(completeArticle({ fullText: '  ' }))).toContain('fullText');
  });

  it('rejects a quality score below 0.3', () => {
    expect(isStorable(completeArticle({ qualityScore: 0.29 }))).toBe(false);
    expect(isStorable(completeArticle({ qualityScore: 0 }))).toBe(false);
    expect(findMissingFields(completeArticle({ qualityScore: 0.1 }))).toContain(
      'qualityScore',
    );
  });

  it('rejects a non-finite quality score', () => {
    expect(isStorable(completeArticle({ qualityScore: Number.NaN }))).toBe(false);
    expect(isStorable(completeArticle({ qualityScore: Number.POSITIVE_INFINITY }))).toBe(
      false,
    );
  });

  it('rejects an embedding of the wrong dimension', () => {
    expect(isStorable(completeArticle({ embedding: [] }))).toBe(false);
    expect(
      isStorable(completeArticle({ embedding: new Array(EMBEDDING_DIMENSIONS - 1).fill(0) })),
    ).toBe(false);
    expect(
      isStorable(completeArticle({ embedding: new Array(EMBEDDING_DIMENSIONS + 1).fill(0) })),
    ).toBe(false);
    expect(
      findMissingFields(completeArticle({ embedding: new Array(10).fill(0) })),
    ).toContain('embedding');
  });

  it('rejects an embedding containing non-finite values', () => {
    const withNaN = validEmbedding();
    withNaN[0] = Number.NaN;
    expect(isStorable(completeArticle({ embedding: withNaN }))).toBe(false);

    const withInfinity = validEmbedding();
    withInfinity[100] = Number.POSITIVE_INFINITY;
    expect(isStorable(completeArticle({ embedding: withInfinity }))).toBe(false);
  });

  it('rejects a non-array embedding', () => {
    expect(isStorable(completeArticle({ embedding: 'nope' as never }))).toBe(false);
    expect(isStorable(completeArticle({ embedding: null as never }))).toBe(false);
  });

  it('rejects a read time below 1 or non-integer', () => {
    expect(isStorable(completeArticle({ readTimeMinutes: 0 }))).toBe(false);
    expect(isStorable(completeArticle({ readTimeMinutes: -3 }))).toBe(false);
    expect(isStorable(completeArticle({ readTimeMinutes: 2.5 }))).toBe(false);
    expect(isStorable(completeArticle({ readTimeMinutes: Number.NaN }))).toBe(false);
    expect(findMissingFields(completeArticle({ readTimeMinutes: 0.5 }))).toContain(
      'readTimeMinutes',
    );
  });

  it('reports every offending field at once', () => {
    const missing = findMissingFields({
      url: '',
      source: 'medium',
      title: '',
      summary: 'ok summary text',
      fullText: '',
      qualityScore: 0.1,
      embedding: [],
      readTimeMinutes: 0,
    });
    expect(missing).toEqual([
      'url',
      'title',
      'fullText',
      'qualityScore',
      'embedding',
      'readTimeMinutes',
    ]);
  });
});

describe('assertComplete', () => {
  it('does not throw for a complete article', () => {
    expect(() => assertComplete(completeArticle())).not.toThrow();
  });

  it('throws IncompleteArticleError listing the missing fields', () => {
    try {
      assertComplete(completeArticle({ summary: '', readTimeMinutes: 0 }));
      expect.unreachable('assertComplete should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteArticleError);
      expect((err as IncompleteArticleError).missingFields).toEqual([
        'summary',
        'readTimeMinutes',
      ]);
    }
  });
});

describe('storeArticle (persist + index only complete articles)', () => {
  function makeDeps(): {
    deps: StoreArticleDeps;
    repository: ArticleStore & { insertComplete: ReturnType<typeof vi.fn> };
    searchIndex: ArticleSearchIndex & { indexComplete: ReturnType<typeof vi.fn> };
  } {
    const repository = {
      insertComplete: vi.fn(async (_article: CompleteArticleInput) => ({ id: 'art-123' })),
    };
    const searchIndex = {
      indexComplete: vi.fn(async (_article: CompleteArticleInput & { id: string }) => {}),
    };
    return { deps: { repository, searchIndex }, repository, searchIndex };
  }

  it('persists and indexes a complete article', async () => {
    const { deps, repository, searchIndex } = makeDeps();
    const article = completeArticle();

    const result = await storeArticle(deps, article);

    expect(result).toEqual({ status: 'stored', id: 'art-123' });
    expect(repository.insertComplete).toHaveBeenCalledTimes(1);
    expect(repository.insertComplete).toHaveBeenCalledWith(article);
    expect(searchIndex.indexComplete).toHaveBeenCalledTimes(1);
    expect(searchIndex.indexComplete).toHaveBeenCalledWith({ ...article, id: 'art-123' });
  });

  it('persists before indexing so the index never references an unstored article', async () => {
    const { deps, repository, searchIndex } = makeDeps();
    const order: string[] = [];
    repository.insertComplete.mockImplementation(async () => {
      order.push('persist');
      return { id: 'art-9' };
    });
    searchIndex.indexComplete.mockImplementation(async () => {
      order.push('index');
    });

    await storeArticle(deps, completeArticle());

    expect(order).toEqual(['persist', 'index']);
  });

  it('refuses storage for an incomplete article and performs no side effects', async () => {
    const { deps, repository, searchIndex } = makeDeps();

    const result = await storeArticle(deps, completeArticle({ embedding: [], qualityScore: 0.1 }));

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.missingFields).toContain('embedding');
      expect(result.missingFields).toContain('qualityScore');
    }
    expect(repository.insertComplete).not.toHaveBeenCalled();
    expect(searchIndex.indexComplete).not.toHaveBeenCalled();
  });

  it('refuses storage for a null article', async () => {
    const { deps, repository, searchIndex } = makeDeps();

    const result = await storeArticle(deps, null);

    expect(result.status).toBe('rejected');
    expect(repository.insertComplete).not.toHaveBeenCalled();
    expect(searchIndex.indexComplete).not.toHaveBeenCalled();
  });

  it('refuses storage for a sub-threshold quality score (Requirement 6.4/6.5)', async () => {
    const { deps, repository, searchIndex } = makeDeps();

    const result = await storeArticle(deps, completeArticle({ qualityScore: 0.299 }));

    expect(result.status).toBe('rejected');
    expect(repository.insertComplete).not.toHaveBeenCalled();
    expect(searchIndex.indexComplete).not.toHaveBeenCalled();
  });
});

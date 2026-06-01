import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { QueryRow } from '../repositories/queryable.js';
import { createArticleDataAccess, getRelatedArticles, MAX_RELATED_ARTICLES } from './detail.js';

// Feature: lumina, Property 21: Related articles are distinct, capped, ordered, and exclude the source
// Validates: Requirements 11.1, 11.2, 11.3

const VECTOR = '[0.1,0.2,0.3]';

function articleRow(id: string): QueryRow {
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
  };
}

/** Build a FakeQueryable whose neighbour query returns `neighbourIds` in order. */
function makeDb(neighbourIds: string[]): FakeQueryable {
  return new FakeQueryable((sql, params) => {
    const n = normalizeSql(sql);
    if (n.includes('FROM article WHERE id =')) {
      return { rows: params[0] === 'src' ? [articleRow('src')] : [] };
    }
    if (n.includes('<=> $1::vector')) return { rows: neighbourIds.map(articleRow) };
    return { rows: [] };
  });
}

describe('getRelatedArticles — Property 21', () => {
  it('returns the first ≤5 distinct non-source neighbours, preserving similarity order', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Similarity-ordered neighbour ids; may include the source and dups.
        fc.array(fc.constantFrom('src', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), {
          minLength: 0,
          maxLength: 20,
        }),
        async (neighbourIds) => {
          const result = await getRelatedArticles(createArticleDataAccess(makeDb(neighbourIds)), 'src');
          expect(result.status).toBe('ok');
          if (result.status !== 'ok') return;

          const ids = result.related.map((a) => a.id);

          // Expected = first 5 distinct ids, excluding the source, in input order.
          const expected: string[] = [];
          const seen = new Set<string>();
          for (const id of neighbourIds) {
            if (id === 'src' || seen.has(id)) continue;
            seen.add(id);
            expected.push(id);
            if (expected.length === MAX_RELATED_ARTICLES) break;
          }

          expect(ids).toEqual(expected); // distinct, source-excluded, order-preserving
          expect(ids.length).toBeLessThanOrEqual(MAX_RELATED_ARTICLES);
          expect(new Set(ids).size).toBe(ids.length); // distinct
          expect(ids).not.toContain('src'); // source excluded
        },
      ),
    );
  });
});

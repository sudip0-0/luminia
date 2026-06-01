import { describe, it, expect } from 'vitest';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import { getTaxonomy } from './taxonomy.js';

// Verifies the Onboarding_Service taxonomy endpoint (Requirement 3.1): each
// Topic is returned with slug, label, parent reference, color, and icon name,
// with the parent exposed as a slug rather than the internal id.

/** A raw `topic` row as returned by the topics repository query. */
function topicRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't-1',
    slug: 'physics',
    label: 'Physics',
    parent_id: null,
    color: '#112233',
    icon_name: 'atom',
    centroid: null,
    ...overrides,
  };
}

describe('getTaxonomy', () => {
  it('maps each topic to slug, label, parentSlug, color, and iconName', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          topicRow({
            id: 't-1',
            slug: 'science',
            label: 'Science',
            parent_id: null,
            color: '#0a0a0a',
            icon_name: 'flask',
          }),
        ],
      },
    ]);

    const taxonomy = await getTaxonomy({ db });

    expect(taxonomy).toEqual([
      {
        slug: 'science',
        label: 'Science',
        parentSlug: null,
        color: '#0a0a0a',
        iconName: 'flask',
      },
    ]);
  });

  it('resolves a child topic parent_id to the parent topic slug', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          topicRow({
            id: 'parent-1',
            slug: 'science',
            label: 'Science',
            parent_id: null,
            icon_name: 'flask',
          }),
          topicRow({
            id: 'child-1',
            slug: 'physics',
            label: 'Physics',
            parent_id: 'parent-1',
            icon_name: 'atom',
          }),
        ],
      },
    ]);

    const taxonomy = await getTaxonomy({ db });

    const physics = taxonomy.find((t) => t.slug === 'physics');
    expect(physics?.parentSlug).toBe('science');
    const science = taxonomy.find((t) => t.slug === 'science');
    expect(science?.parentSlug).toBeNull();
  });

  it('exposes parentSlug as null when the parent id is not in the loaded set', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          topicRow({
            id: 'child-1',
            slug: 'physics',
            parent_id: 'missing-parent',
          }),
        ],
      },
    ]);

    const taxonomy = await getTaxonomy({ db });

    expect(taxonomy[0]?.parentSlug).toBeNull();
  });

  it('does not leak internal ids or centroids in the DTO', async () => {
    const db = new FakeQueryable([
      { rows: [topicRow({ centroid: '[0.1,0.2]' })] },
    ]);

    const taxonomy = await getTaxonomy({ db });

    expect(taxonomy[0]).not.toHaveProperty('id');
    expect(taxonomy[0]).not.toHaveProperty('centroid');
    expect(Object.keys(taxonomy[0] ?? {}).sort()).toEqual([
      'color',
      'iconName',
      'label',
      'parentSlug',
      'slug',
    ]);
  });

  it('reads via the topics repository ordered by slug', async () => {
    const db = new FakeQueryable([{ rows: [] }]);

    const taxonomy = await getTaxonomy({ db });

    expect(taxonomy).toEqual([]);
    expect(db.lastCall.sql).toContain('FROM topic');
    expect(db.lastCall.sql).toContain('ORDER BY slug ASC');
  });
});

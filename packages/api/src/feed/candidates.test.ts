import { describe, it, expect } from 'vitest';
import { FakeQueryable, normalizeSql } from '../repositories/fake-queryable.js';
import type { CannedResult } from '../repositories/fake-queryable.js';
import {
  DEFAULT_CANDIDATE_LIMIT,
  FORYOU_TAB,
  resolveCandidates,
} from './candidates.js';

// Verifies candidate resolution and exclusions (design `assembleFeed` step 1):
// muted-topic exclusion (Requirement 25.2), prior-skip exclusion
// (Requirement 8.6), topic-slug restriction (Requirement 8.4), and the
// `foryou` no-restriction path. All DB access goes through a responder-based
// FakeQueryable that branches on the SQL it receives, so query ordering (the
// muted/skip reads run concurrently) does not affect the assertions.

/** A complete `article` row in the snake_case shape `mapArticle` expects. */
function articleRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: id.padEnd(64, '0'),
    source: 'wikipedia',
    title: `Title ${id}`,
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

/** A `topic` row in the shape `mapTopic` expects. */
function topicRow(id: string, slug: string) {
  return {
    id,
    slug,
    label: slug,
    parent_id: null,
    color: '#fff',
    icon_name: 'icon',
    centroid: null,
  };
}

/** Options describing the canned rows each query should return. */
interface FakeData {
  topic?: ReturnType<typeof topicRow> | null;
  mutedTopicIds?: string[];
  skippedArticleIds?: string[];
  candidates?: ReturnType<typeof articleRow>[];
  /** article_id -> topic_ids associations returned by listTopicIdsForArticles. */
  associations?: { article_id: string; topic_id: string }[];
}

/**
 * Build a responder-based FakeQueryable that returns canned rows keyed by which
 * statement is being executed, so the concurrent muted/skip reads and the
 * candidate/association reads each get the right data regardless of order.
 */
function fakeDb(data: FakeData): FakeQueryable {
  return new FakeQueryable((sql): CannedResult => {
    const s = normalizeSql(sql);
    if (s.includes('FROM topic') && s.includes('slug = $1')) {
      return { rows: data.topic ? [data.topic] : [] };
    }
    if (s.includes('FROM user_topic') && s.includes('muted = true')) {
      return { rows: (data.mutedTopicIds ?? []).map((topic_id) => ({ topic_id })) };
    }
    if (s.includes('FROM feed_event')) {
      return {
        rows: (data.skippedArticleIds ?? []).map((article_id) => ({ article_id })),
      };
    }
    // Order matters: the candidate query also references `article_topic` in an
    // EXISTS sub-select, so match `FROM article a` before `FROM article_topic`.
    if (s.includes('FROM article a')) {
      return { rows: data.candidates ?? [] };
    }
    if (s.includes('FROM article_topic')) {
      return {
        rows: (data.associations ?? []).map((a) => ({
          article_id: a.article_id,
          topic_id: a.topic_id,
          confidence: '0.9',
        })),
      };
    }
    return { rows: [] };
  });
}

describe('resolveCandidates — foryou path', () => {
  it('applies no topic restriction and never looks up a slug', async () => {
    const db = fakeDb({
      candidates: [articleRow('a1'), articleRow('a2')],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.topicId).toBeNull();
    expect(res.result.candidates.map((c) => c.id)).toEqual(['a1', 'a2']);

    // No topic slug lookup was issued for the foryou tab.
    expect(db.calls.some((c) => normalizeSql(c.sql).includes('FROM topic'))).toBe(
      false,
    );
    // The candidate query carries no topic EXISTS restriction.
    const candidateCall = db.calls.find((c) =>
      normalizeSql(c.sql).includes('FROM article a'),
    );
    expect(candidateCall).toBeDefined();
    expect(normalizeSql(candidateCall!.sql)).not.toContain('at.topic_id');
  });

  it('uses the default candidate limit when none is supplied', async () => {
    const db = fakeDb({ candidates: [articleRow('a1')] });
    await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });
    const candidateCall = db.calls.find((c) =>
      normalizeSql(c.sql).includes('FROM article a'),
    );
    // The last positional param of listArticleCandidates is the LIMIT.
    expect(candidateCall!.params.at(-1)).toBe(DEFAULT_CANDIDATE_LIMIT);
  });
});

describe('resolveCandidates — topic-slug restriction (Req 8.4)', () => {
  it('restricts the candidate query to the resolved topic id', async () => {
    const db = fakeDb({
      topic: topicRow('topic-physics', 'physics'),
      candidates: [articleRow('a1')],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: 'physics' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.topicId).toBe('topic-physics');

    const candidateCall = db.calls.find((c) =>
      normalizeSql(c.sql).includes('FROM article a'),
    );
    // The topic id is bound as a parameter (never interpolated).
    expect(candidateCall!.params).toContain('topic-physics');
    expect(normalizeSql(candidateCall!.sql)).toContain('at.topic_id');
  });

  it('rejects an unknown tab slug with a validation error and no candidate query', async () => {
    const db = fakeDb({ topic: null });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: 'not-a-topic' });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.error.code).toBe('VALIDATION_ERROR');
    // No candidate pool was fetched for an invalid tab.
    expect(
      db.calls.some((c) => normalizeSql(c.sql).includes('FROM article a')),
    ).toBe(false);
  });
});

describe('resolveCandidates — skip exclusion (Req 8.6)', () => {
  it('passes prior-skip article ids to the candidate query exclusion', async () => {
    const db = fakeDb({
      skippedArticleIds: ['skip-1', 'skip-2'],
      candidates: [articleRow('a1')],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.skippedArticleIds).toEqual(['skip-1', 'skip-2']);

    const candidateCall = db.calls.find((c) =>
      normalizeSql(c.sql).includes('FROM article a'),
    );
    expect(normalizeSql(candidateCall!.sql)).toContain('a.id NOT IN');
    expect(candidateCall!.params).toContain('skip-1');
    expect(candidateCall!.params).toContain('skip-2');
  });
});

describe('resolveCandidates — muted-topic exclusion (Req 25.2)', () => {
  it('drops candidates associated with a muted topic', async () => {
    const db = fakeDb({
      mutedTopicIds: ['muted-topic'],
      candidates: [articleRow('keep'), articleRow('drop')],
      associations: [
        { article_id: 'keep', topic_id: 'other-topic' },
        { article_id: 'drop', topic_id: 'muted-topic' },
      ],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.mutedTopicIds).toEqual(['muted-topic']);
    expect(res.result.candidates.map((c) => c.id)).toEqual(['keep']);
  });

  it('skips the association lookup entirely when the user mutes nothing', async () => {
    const db = fakeDb({
      mutedTopicIds: [],
      candidates: [articleRow('a1'), articleRow('a2')],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: FORYOU_TAB });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candidates.map((c) => c.id)).toEqual(['a1', 'a2']);
    // No article_topic association query was issued.
    expect(
      db.calls.some((c) =>
        normalizeSql(c.sql).startsWith('SELECT article_id, topic_id, confidence'),
      ),
    ).toBe(false);
  });

  it('excludes muted-topic articles even within a topic-restricted feed', async () => {
    const db = fakeDb({
      topic: topicRow('topic-1', 'science'),
      mutedTopicIds: ['muted-topic'],
      candidates: [articleRow('keep'), articleRow('drop')],
      associations: [
        { article_id: 'keep', topic_id: 'topic-1' },
        { article_id: 'drop', topic_id: 'muted-topic' },
      ],
    });

    const res = await resolveCandidates({ db }, { userId: 'u1', tab: 'science' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.candidates.map((c) => c.id)).toEqual(['keep']);
  });
});

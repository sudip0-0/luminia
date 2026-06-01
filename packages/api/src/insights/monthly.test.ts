import { describe, it, expect } from 'vitest';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import type { Source } from '@lumina/shared';
import {
  computeMonthlyInsights,
  getMonthlyInsights,
  monthBounds,
  type ComputeMonthlyInsightsInput,
} from './monthly.js';
import type { FeedEventRecord } from '../repositories/types.js';

// Verifies the Insights_Service monthly aggregates (Requirements 24.1, 24.3,
// 24.8): articles read, quality reading minutes (skips excluded), newly
// discovered topics, the per-source minute breakdown, and the no-history zero
// case. The pure `computeMonthlyInsights` is exercised directly, and
// `getMonthlyInsights` is exercised end-to-end through an in-memory
// `FakeQueryable` that answers each repository query by inspecting its SQL.

const MS_PER_MINUTE = 60_000;

/** Build a FeedEventRecord with sensible defaults for the fields under test. */
function event(overrides: Partial<FeedEventRecord> = {}): FeedEventRecord {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    clientEventId: overrides.clientEventId ?? `cli-${Math.random().toString(36).slice(2)}`,
    userId: overrides.userId ?? 'u-1',
    articleId: overrides.articleId ?? null,
    topicId: overrides.topicId ?? null,
    type: overrides.type ?? 'dwell',
    payload: overrides.payload ?? {},
    occurredAt: overrides.occurredAt ?? '2024-04-10T12:00:00.000Z',
    createdAt: overrides.createdAt ?? '2024-04-10T12:00:00.000Z',
  };
}

/** A dwell event for `articleId` carrying `minutes` worth of reading time. */
function dwell(articleId: string, minutes: number, occurredAt?: string): FeedEventRecord {
  return event({
    type: 'dwell',
    articleId,
    payload: { dwellMs: minutes * MS_PER_MINUTE },
    occurredAt,
  });
}

const EMPTY_INPUT: ComputeMonthlyInsightsInput = {
  monthLabel: '2024-04',
  monthEvents: [],
  priorDwellEvents: [],
  sourceByArticleId: new Map(),
  topicsByArticleId: new Map(),
};

describe('monthBounds', () => {
  it('computes inclusive-start / exclusive-end UTC bounds for the calendar month', () => {
    const bounds = monthBounds(Date.parse('2024-04-15T09:30:00.000Z'));
    expect(bounds.label).toBe('2024-04');
    expect(bounds.startIso).toBe('2024-04-01T00:00:00.000Z');
    expect(bounds.endIso).toBe('2024-05-01T00:00:00.000Z');
  });

  it('rolls the exclusive upper bound over a year boundary', () => {
    const bounds = monthBounds(Date.parse('2024-12-31T23:59:59.000Z'));
    expect(bounds.label).toBe('2024-12');
    expect(bounds.startIso).toBe('2024-12-01T00:00:00.000Z');
    expect(bounds.endIso).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('computeMonthlyInsights — counts and minutes', () => {
  it('counts distinct articles read and sums quality minutes (24.1, 24.3)', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [
        dwell('a-1', 5),
        dwell('a-1', 3), // same article, still one "read"; minutes accumulate
        dwell('a-2', 10),
        event({ type: 'impression', articleId: 'a-3' }), // not a dwell => not read
      ],
      sourceByArticleId: new Map<string, Source>([
        ['a-1', 'wikipedia'],
        ['a-2', 'arxiv'],
      ]),
    });
    expect(result.articlesRead).toBe(2);
    expect(result.qualityReadingMinutes).toBe(18);
  });

  it('floors fractional reading time to whole minutes (24.1)', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [
        event({ type: 'dwell', articleId: 'a-1', payload: { dwellMs: 90_000 } }), // 1.5 min
        event({ type: 'dwell', articleId: 'a-2', payload: { dwellMs: 119_000 } }), // ~1.98 min
      ],
      sourceByArticleId: new Map<string, Source>([
        ['a-1', 'medium'],
        ['a-2', 'medium'],
      ]),
    });
    // 209_000 ms total => 3.48 min => floored 3.
    expect(result.qualityReadingMinutes).toBe(3);
  });
});

describe('computeMonthlyInsights — skip exclusion (24.3)', () => {
  it('excludes skip events from quality reading minutes', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [
        dwell('a-1', 6),
        // A skip carrying a (spurious) dwellMs payload must NOT be counted.
        event({ type: 'skip', articleId: 'a-2', payload: { dwellMs: 100 * MS_PER_MINUTE } }),
      ],
      sourceByArticleId: new Map<string, Source>([['a-1', 'wikipedia']]),
    });
    expect(result.qualityReadingMinutes).toBe(6);
    // Skip does not make the article "read" either.
    expect(result.articlesRead).toBe(1);
  });
});

describe('computeMonthlyInsights — per-source breakdown (24.3)', () => {
  it('groups minutes by source, ordered by descending minutes then source', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [
        dwell('a-1', 5),
        dwell('a-2', 8),
        dwell('a-3', 8), // ties with arxiv total below; ordering breaks by source
      ],
      sourceByArticleId: new Map<string, Source>([
        ['a-1', 'wikipedia'], // 5
        ['a-2', 'arxiv'], // 8
        ['a-3', 'medium'], // 8
      ]),
    });
    expect(result.readingTimeBySource).toEqual([
      { source: 'arxiv', minutes: 8 },
      { source: 'medium', minutes: 8 },
      { source: 'wikipedia', minutes: 5 },
    ]);
  });

  it('aggregates multiple articles from the same source', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [dwell('a-1', 4), dwell('a-2', 7)],
      sourceByArticleId: new Map<string, Source>([
        ['a-1', 'hacker_news'],
        ['a-2', 'hacker_news'],
      ]),
    });
    expect(result.readingTimeBySource).toEqual([{ source: 'hacker_news', minutes: 11 }]);
  });

  it('omits sources contributing less than one whole minute', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [
        event({ type: 'dwell', articleId: 'a-1', payload: { dwellMs: 30_000 } }), // 0.5 min
      ],
      sourceByArticleId: new Map<string, Source>([['a-1', 'quanta']]),
    });
    expect(result.readingTimeBySource).toEqual([]);
  });
});

describe('computeMonthlyInsights — newly discovered topics (24.1)', () => {
  it('counts topics whose first dwell is in the month', () => {
    const result = computeMonthlyInsights({
      ...EMPTY_INPUT,
      monthEvents: [dwell('a-1', 5), dwell('a-2', 5)],
      priorDwellEvents: [dwell('a-0', 5, '2024-03-15T00:00:00.000Z')],
      sourceByArticleId: new Map<string, Source>([
        ['a-1', 'wikipedia'],
        ['a-2', 'wikipedia'],
      ]),
      topicsByArticleId: new Map<string, string[]>([
        ['a-0', ['t-physics']], // engaged before the month
        ['a-1', ['t-physics', 't-biology']], // physics not new; biology new
        ['a-2', ['t-history']], // new
      ]),
    });
    // New topics: biology, history. Physics was seen last month.
    expect(result.newlyDiscoveredTopics).toBe(2);
  });
});

describe('computeMonthlyInsights — no history (24.8)', () => {
  it('returns zero counts and an empty breakdown', () => {
    const result = computeMonthlyInsights(EMPTY_INPUT);
    expect(result).toEqual({
      month: '2024-04',
      articlesRead: 0,
      qualityReadingMinutes: 0,
      newlyDiscoveredTopics: 0,
      readingTimeBySource: [],
    });
  });
});

/**
 * Build a FakeQueryable responder that answers the four query shapes
 * `getMonthlyInsights` issues, keyed off recognizable SQL fragments.
 */
function buildDb(opts: {
  monthRows: Record<string, unknown>[];
  priorRows: Record<string, unknown>[];
  articleRows: Record<string, Record<string, unknown>>;
  topicRows: Record<string, unknown>[];
}): FakeQueryable {
  return new FakeQueryable((sql, params) => {
    if (sql.includes('FROM feed_event')) {
      // The prior-dwell query restricts by `type IN (...)`; the month query does not.
      return sql.includes('type IN') ? { rows: opts.priorRows } : { rows: opts.monthRows };
    }
    if (sql.includes('FROM article ') || sql.includes('FROM article\n')) {
      const id = params[0] as string;
      const row = opts.articleRows[id];
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM article_topic')) {
      return { rows: opts.topicRows };
    }
    return { rows: [] };
  });
}

/** A raw feed_event row as the `pg` driver would return it. */
function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    client_event_id: 'cli-1',
    user_id: 'u-1',
    article_id: null,
    topic_id: null,
    type: 'dwell',
    payload: {},
    occurred_at: new Date('2024-04-10T12:00:00.000Z'),
    created_at: new Date('2024-04-10T12:00:00.000Z'),
    ...overrides,
  };
}

/** A raw article row exposing the columns the source lookup reads. */
function articleRow(id: string, source: Source): Record<string, unknown> {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: `hash-${id}`,
    source,
    title: `Title ${id}`,
    summary: 'Summary',
    full_text: 'Full text',
    embedding: null,
    quality_score: 0.8,
    difficulty: null,
    read_time_minutes: 5,
    summarization_status: 'summarized',
    published_at: new Date('2024-04-01T00:00:00.000Z'),
    ingested_at: new Date('2024-04-01T00:00:00.000Z'),
  };
}

describe('getMonthlyInsights — end-to-end over FakeQueryable', () => {
  const NOW = Date.parse('2024-04-20T10:00:00.000Z');

  it('aggregates month events into counts, minutes, and the source breakdown', async () => {
    const db = buildDb({
      monthRows: [
        eventRow({
          id: 'e1',
          article_id: 'a-1',
          type: 'dwell',
          payload: { dwellMs: 5 * MS_PER_MINUTE },
        }),
        eventRow({
          id: 'e2',
          article_id: 'a-2',
          type: 'dwell',
          payload: { dwellMs: 10 * MS_PER_MINUTE },
        }),
        eventRow({ id: 'e3', article_id: 'a-2', type: 'skip', payload: {} }),
      ],
      priorRows: [],
      articleRows: {
        'a-1': articleRow('a-1', 'wikipedia'),
        'a-2': articleRow('a-2', 'arxiv'),
      },
      topicRows: [
        { article_id: 'a-1', topic_id: 't-physics', confidence: 0.9 },
        { article_id: 'a-2', topic_id: 't-cs', confidence: 0.8 },
      ],
    });

    const result = await getMonthlyInsights({ db }, 'u-1', NOW);

    expect(result.month).toBe('2024-04');
    expect(result.articlesRead).toBe(2);
    expect(result.qualityReadingMinutes).toBe(15);
    expect(result.newlyDiscoveredTopics).toBe(2);
    expect(result.readingTimeBySource).toEqual([
      { source: 'arxiv', minutes: 10 },
      { source: 'wikipedia', minutes: 5 },
    ]);
  });

  it('treats topics engaged before the month as not newly discovered', async () => {
    const db = buildDb({
      monthRows: [
        eventRow({
          id: 'e1',
          article_id: 'a-1',
          type: 'dwell',
          payload: { dwellMs: 5 * MS_PER_MINUTE },
        }),
      ],
      priorRows: [
        eventRow({
          id: 'p1',
          article_id: 'a-0',
          type: 'dwell',
          occurred_at: new Date('2024-03-10T00:00:00.000Z'),
          payload: { dwellMs: 5 * MS_PER_MINUTE },
        }),
      ],
      articleRows: { 'a-1': articleRow('a-1', 'medium') },
      topicRows: [
        { article_id: 'a-0', topic_id: 't-physics', confidence: 0.9 },
        { article_id: 'a-1', topic_id: 't-physics', confidence: 0.7 },
      ],
    });

    const result = await getMonthlyInsights({ db }, 'u-1', NOW);

    expect(result.articlesRead).toBe(1);
    // The only topic (physics) was already engaged last month.
    expect(result.newlyDiscoveredTopics).toBe(0);
  });

  it('returns zero counts and an empty breakdown when there is no history (24.8)', async () => {
    const db = buildDb({
      monthRows: [],
      priorRows: [],
      articleRows: {},
      topicRows: [],
    });

    const result = await getMonthlyInsights({ db }, 'u-1', NOW);

    expect(result).toEqual({
      month: '2024-04',
      articlesRead: 0,
      qualityReadingMinutes: 0,
      newlyDiscoveredTopics: 0,
      readingTimeBySource: [],
    });
    // With no in-month reads we never issue an article lookup.
    expect(db.calls.some((c) => c.sql.includes('FROM article '))).toBe(false);
  });
});

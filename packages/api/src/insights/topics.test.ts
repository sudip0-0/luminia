import { describe, it, expect } from 'vitest';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import {
  classifyTrend,
  eventSignal,
  getTopicBreakdown,
  getTopicWeights,
} from './topics.js';
import type { FeedEventRecord } from '../repositories/types.js';

// Verifies the Insights_Service topic breakdown (Requirement 24.2) and the
// topic-weights endpoint (Requirement 25.1): descending-weight ordering, the
// growing/fading/steady trend classification at the ±10% boundaries, and the
// weight+muted response shape. The pure `classifyTrend`/`eventSignal` are
// exercised directly, and the two orchestrators are exercised end-to-end
// through an in-memory `FakeQueryable` that answers each repository query by
// inspecting its SQL.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A raw user_topic row as the `pg` driver would return it. */
function userTopicRow(
  topicId: string,
  weight: number,
  muted = false,
  source: 'onboarding' | 'inferred' = 'onboarding',
): Record<string, unknown> {
  return {
    user_id: 'u-1',
    topic_id: topicId,
    weight,
    source,
    muted,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
  };
}

/** A raw feed_event row exposing the columns the breakdown reads. */
function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    client_event_id: `cli-${Math.random().toString(36).slice(2)}`,
    user_id: 'u-1',
    article_id: null,
    topic_id: null,
    type: 'dwell',
    payload: {},
    occurred_at: new Date('2024-04-10T00:00:00.000Z'),
    created_at: new Date('2024-04-10T00:00:00.000Z'),
    ...overrides,
  };
}

/** A raw article_topic row. */
function articleTopicRow(
  articleId: string,
  topicId: string,
  confidence = 0.9,
): Record<string, unknown> {
  return { article_id: articleId, topic_id: topicId, confidence };
}

/** Build a FakeQueryable that answers the three query shapes by SQL fragment. */
function buildDb(opts: {
  userTopicRows: Record<string, unknown>[];
  eventRows?: Record<string, unknown>[];
  articleTopicRows?: Record<string, unknown>[];
}): FakeQueryable {
  return new FakeQueryable((sql) => {
    if (sql.includes('FROM user_topic')) return { rows: opts.userTopicRows };
    if (sql.includes('FROM feed_event')) return { rows: opts.eventRows ?? [] };
    if (sql.includes('FROM article_topic')) return { rows: opts.articleTopicRows ?? [] };
    return { rows: [] };
  });
}

describe('eventSignal', () => {
  function ev(type: FeedEventRecord['type'], payload: Record<string, unknown> = {}): FeedEventRecord {
    return {
      id: 'e',
      clientEventId: 'c',
      userId: 'u-1',
      articleId: null,
      topicId: null,
      type,
      payload,
      occurredAt: '2024-04-10T00:00:00.000Z',
      createdAt: '2024-04-10T00:00:00.000Z',
    };
  }

  it('assigns the documented fixed per-type weights (14.3)', () => {
    expect(eventSignal(ev('save'))).toBe(0.5);
    expect(eventSignal(ev('dwell'))).toBe(0.15);
    expect(eventSignal(ev('skip'))).toBe(-0.2);
    expect(eventSignal(ev('mute_topic'))).toBe(-1.0);
  });

  it('scales scroll_depth by the clamped scroll proportion', () => {
    expect(eventSignal(ev('scroll_depth', { scrollProportion: 0.5 }))).toBeCloseTo(0.05);
    expect(eventSignal(ev('scroll_depth', { scrollProportion: 2 }))).toBeCloseTo(0.1); // clamped to 1
    expect(eventSignal(ev('scroll_depth', {}))).toBe(0); // missing => 0
  });
});

describe('classifyTrend — boundaries (24.2)', () => {
  it('labels growing only when the increase exceeds +10%', () => {
    expect(classifyTrend(111, 100)).toBe('growing'); // +11%
    expect(classifyTrend(110, 100)).toBe('steady'); // exactly +10% => steady
  });

  it('labels fading only when the decrease exceeds 10%', () => {
    expect(classifyTrend(89, 100)).toBe('fading'); // -11%
    expect(classifyTrend(90, 100)).toBe('steady'); // exactly -10% => steady
  });

  it('labels steady within the ±10% band', () => {
    expect(classifyTrend(100, 100)).toBe('steady');
    expect(classifyTrend(105, 100)).toBe('steady');
    expect(classifyTrend(95, 100)).toBe('steady');
  });

  it('classifies by direction when prior signal is non-positive', () => {
    expect(classifyTrend(0.5, 0)).toBe('growing'); // new interest
    expect(classifyTrend(0, 0)).toBe('steady'); // no signal either window
    expect(classifyTrend(-1, -2)).toBe('growing'); // rose toward 0
    expect(classifyTrend(-2, -1)).toBe('fading'); // fell further negative
  });
});

describe('getTopicBreakdown — ordering and classification (24.2)', () => {
  const NOW = Date.parse('2024-04-15T00:00:00.000Z');
  // recent window: [2024-04-08, 2024-04-15); prior window: [2024-04-01, 2024-04-08).
  const recentAt = new Date(NOW - 3 * DAY_MS); // 2024-04-12
  const priorAt = new Date(NOW - 10 * DAY_MS); // 2024-04-05

  it('orders by descending weight and labels each topic by 7-day change', async () => {
    const db = buildDb({
      // Repository returns these already ordered by descending weight.
      userTopicRows: [
        userTopicRow('t-fade', 1.5),
        userTopicRow('t-grow', 1.2),
        userTopicRow('t-steady', 0.8),
      ],
      eventRows: [
        // t-grow: prior 0.15 (dwell) -> recent 1.0 (two saves) => growing
        eventRow({ topic_id: 't-grow', type: 'dwell', occurred_at: priorAt }),
        eventRow({ topic_id: 't-grow', type: 'save', occurred_at: recentAt }),
        eventRow({ topic_id: 't-grow', type: 'save', occurred_at: recentAt }),
        // t-fade: prior 1.0 (two saves) -> recent 0.15 (dwell) => fading
        eventRow({ topic_id: 't-fade', type: 'save', occurred_at: priorAt }),
        eventRow({ topic_id: 't-fade', type: 'save', occurred_at: priorAt }),
        eventRow({ topic_id: 't-fade', type: 'dwell', occurred_at: recentAt }),
        // t-steady: 0.5 (save) in each window => steady
        eventRow({ topic_id: 't-steady', type: 'save', occurred_at: priorAt }),
        eventRow({ topic_id: 't-steady', type: 'save', occurred_at: recentAt }),
      ],
    });

    const result = await getTopicBreakdown({ db }, 'u-1', NOW);

    expect(result).toEqual([
      { topicId: 't-fade', weight: 1.5, trend: 'fading' },
      { topicId: 't-grow', weight: 1.2, trend: 'growing' },
      { topicId: 't-steady', weight: 0.8, trend: 'steady' },
    ]);
  });

  it('attributes article-targeted events to the article topics', async () => {
    const db = buildDb({
      userTopicRows: [userTopicRow('t-1', 1.0)],
      eventRows: [
        // No prior-window signal; a recent save on an article mapped to t-1.
        eventRow({ article_id: 'a-1', type: 'save', occurred_at: recentAt }),
      ],
      articleTopicRows: [articleTopicRow('a-1', 't-1')],
    });

    const result = await getTopicBreakdown({ db }, 'u-1', NOW);

    // prior 0, recent 0.5 => growing (direction rule).
    expect(result).toEqual([{ topicId: 't-1', weight: 1.0, trend: 'growing' }]);
  });

  it('labels topics with no events in either window as steady', async () => {
    const db = buildDb({
      userTopicRows: [userTopicRow('t-quiet', 0.4)],
      eventRows: [],
    });

    const result = await getTopicBreakdown({ db }, 'u-1', NOW);
    expect(result).toEqual([{ topicId: 't-quiet', weight: 0.4, trend: 'steady' }]);
  });

  it('ignores events that fall outside the 14-day comparison window', async () => {
    const db = buildDb({
      userTopicRows: [userTopicRow('t-1', 1.0)],
      eventRows: [
        // Older than the prior window (15 days ago) — must be ignored.
        eventRow({ topic_id: 't-1', type: 'save', occurred_at: new Date(NOW - 15 * DAY_MS) }),
      ],
    });

    const result = await getTopicBreakdown({ db }, 'u-1', NOW);
    expect(result).toEqual([{ topicId: 't-1', weight: 1.0, trend: 'steady' }]);
  });

  it('returns an empty breakdown and issues no event query when the user has no topics', async () => {
    const db = buildDb({ userTopicRows: [] });

    const result = await getTopicBreakdown({ db }, 'u-1', NOW);

    expect(result).toEqual([]);
    expect(db.calls.some((c) => c.sql.includes('FROM feed_event'))).toBe(false);
  });
});

describe('getTopicWeights — shape and ordering (25.1)', () => {
  it('returns each topic with its weight and muted state, descending by weight', async () => {
    const db = buildDb({
      userTopicRows: [
        userTopicRow('t-a', 1.8, false),
        userTopicRow('t-b', 1.1, true),
        userTopicRow('t-c', 0.3, false),
      ],
    });

    const result = await getTopicWeights({ db }, 'u-1');

    expect(result).toEqual([
      { topicId: 't-a', weight: 1.8, muted: false },
      { topicId: 't-b', weight: 1.1, muted: true },
      { topicId: 't-c', weight: 0.3, muted: false },
    ]);
    // Relies on the repository's `ORDER BY weight DESC` query.
    expect(db.lastCall.sql).toContain('ORDER BY weight DESC');
  });

  it('returns an empty list when the user has no topics', async () => {
    const db = buildDb({ userTopicRows: [] });
    expect(await getTopicWeights({ db }, 'u-1')).toEqual([]);
  });
});

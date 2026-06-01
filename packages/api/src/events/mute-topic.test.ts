import { describe, it, expect } from 'vitest';
import type { FeedEventInput } from '@lumina/shared';
import { FakeQueryable, type CannedResult } from '../repositories/fake-queryable.js';
import { resolveMuteTopicTarget, resolveMuteTopicEvent } from './mute-topic.js';

// Verifies mute_topic target resolution (Requirement 23.4): a mute_topic event
// for an article targets the topic with the highest association confidence for
// that article, with deterministic tie-breaking and a null result when the
// article has no topic associations.

/** A single `article_topic` association row as stored. */
interface Assoc {
  article_id: string;
  topic_id: string;
  confidence: number;
}

/**
 * A FakeQueryable that simulates `findHighestConfidenceTopic`: the repository
 * issues `SELECT … FROM article_topic WHERE article_id = $1 ORDER BY confidence
 * DESC, topic_id ASC LIMIT 1`. We reproduce that ordering over the seeded
 * associations so the test exercises the real selection contract rather than a
 * hand-picked row.
 */
function makeDb(associations: Assoc[]): FakeQueryable {
  return new FakeQueryable((sql, params): CannedResult => {
    if (sql.includes('FROM article_topic')) {
      const articleId = params[0] as string;
      const matches = associations
        .filter((a) => a.article_id === articleId)
        .sort((a, b) =>
          b.confidence - a.confidence !== 0
            ? b.confidence - a.confidence
            : a.topic_id.localeCompare(b.topic_id),
        );
      const top = matches[0];
      return { rows: top ? [top] : [] };
    }
    return { rows: [] };
  });
}

function muteEvent(
  overrides: Partial<FeedEventInput> & { clientEventId: string },
): FeedEventInput {
  return {
    type: 'mute_topic',
    articleId: 'art-1',
    payload: {},
    occurredAt: '2024-03-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveMuteTopicTarget (Req 23.4)', () => {
  it('selects the highest-confidence topic among several associations', async () => {
    const db = makeDb([
      { article_id: 'art-1', topic_id: 't-low', confidence: 0.1 },
      { article_id: 'art-1', topic_id: 't-high', confidence: 0.9 },
      { article_id: 'art-1', topic_id: 't-mid', confidence: 0.5 },
    ]);

    const topicId = await resolveMuteTopicTarget({ db }, 'art-1');

    expect(topicId).toBe('t-high');
  });

  it('breaks ties deterministically by topic id (ascending)', async () => {
    const db = makeDb([
      { article_id: 'art-1', topic_id: 't-beta', confidence: 0.7 },
      { article_id: 'art-1', topic_id: 't-alpha', confidence: 0.7 },
      { article_id: 'art-1', topic_id: 't-gamma', confidence: 0.3 },
    ]);

    const topicId = await resolveMuteTopicTarget({ db }, 'art-1');

    expect(topicId).toBe('t-alpha');
  });

  it('returns null when the article has no topic associations', async () => {
    const db = makeDb([]);

    const topicId = await resolveMuteTopicTarget({ db }, 'art-orphan');

    expect(topicId).toBeNull();
  });

  it('parameterizes the query by article id and never interpolates it', async () => {
    const db = makeDb([{ article_id: 'art-1', topic_id: 't-high', confidence: 0.9 }]);

    await resolveMuteTopicTarget({ db }, 'art-1');

    expect(db.lastCall.params).toEqual(['art-1']);
    expect(db.lastCall.sql).not.toContain('art-1');
  });
});

describe('resolveMuteTopicEvent (Req 23.4)', () => {
  it('enriches a mute_topic event with the highest-confidence topic id', async () => {
    const db = makeDb([
      { article_id: 'art-1', topic_id: 't-low', confidence: 0.2 },
      { article_id: 'art-1', topic_id: 't-high', confidence: 0.8 },
    ]);

    const enriched = await resolveMuteTopicEvent(
      { db },
      muteEvent({ clientEventId: 'ce-1' }),
    );

    expect(enriched).not.toBeNull();
    expect(enriched).toMatchObject({
      clientEventId: 'ce-1',
      articleId: 'art-1',
      topicId: 't-high',
      type: 'mute_topic',
      occurredAt: '2024-03-01T00:00:00.000Z',
    });
  });

  it('returns null when the article has no topic associations (nothing to mute)', async () => {
    const db = makeDb([]);

    const enriched = await resolveMuteTopicEvent(
      { db },
      muteEvent({ clientEventId: 'ce-1', articleId: 'art-orphan' }),
    );

    expect(enriched).toBeNull();
  });

  it('returns null when the event carries no articleId', async () => {
    const db = makeDb([{ article_id: 'art-1', topic_id: 't-high', confidence: 0.9 }]);

    const enriched = await resolveMuteTopicEvent(
      { db },
      muteEvent({ clientEventId: 'ce-1', articleId: null }),
    );

    expect(enriched).toBeNull();
    // No article to resolve against -> the repository is never queried.
    expect(db.calls).toHaveLength(0);
  });
});

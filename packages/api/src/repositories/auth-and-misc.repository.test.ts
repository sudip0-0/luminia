import { describe, it, expect } from 'vitest';
import { FakeQueryable } from './fake-queryable.js';
import {
  findOAuthIdentity,
  linkOAuthIdentity,
} from './oauth-identities.repository.js';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
} from './refresh-tokens.repository.js';
import {
  associateArticleTopics,
  findHighestConfidenceTopic,
} from './article-topics.repository.js';
import {
  getUserEmbedding,
  upsertUserEmbedding,
} from './user-embeddings.repository.js';
import {
  deleteEmergingTopic,
  listEmergingTopics,
  recordEmergingTopic,
} from './emerging-topics.repository.js';
import {
  getCrawlState,
  recordCrawlFailure,
  updateLastSuccessfulCrawl,
} from './crawl.repository.js';

// Verifies the remaining repositories: oauth identities (1.5), refresh tokens
// (2.1, 2.5), article-topic associations + highest-confidence (7.2, 23.4),
// user embeddings (9.7, 14.4), emerging topics (14.7, 24.x), crawl state (5.x).

describe('oauth-identities repository', () => {
  it('links an identity with a parameterized insert', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            id: 'oi-1',
            user_id: 'u-1',
            provider: 'google',
            provider_user_id: 'g-123',
            email: 'a@b.com',
            created_at: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      },
    ]);
    const identity = await linkOAuthIdentity(db, {
      userId: 'u-1',
      provider: 'google',
      providerUserId: 'g-123',
      email: 'a@b.com',
    });
    expect(db.lastCall.params).toEqual(['u-1', 'google', 'g-123', 'a@b.com']);
    expect(identity.provider).toBe('google');
  });

  it('finds an identity by provider + provider user id', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await findOAuthIdentity(db, 'apple', 'a-1')).toBeNull();
    expect(db.lastCall.sql).toContain('WHERE provider = $1 AND provider_user_id = $2');
    expect(db.lastCall.params).toEqual(['apple', 'a-1']);
  });
});

describe('refresh-tokens repository', () => {
  it('creates a token from its hash and expiry', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            id: 'rt-1',
            user_id: 'u-1',
            token_hash: 'h',
            expires_at: new Date('2024-12-31T00:00:00.000Z'),
            revoked_at: null,
            created_at: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      },
    ]);
    const token = await createRefreshToken(db, {
      userId: 'u-1',
      tokenHash: 'h',
      expiresAt: '2024-12-31T00:00:00.000Z',
    });
    expect(db.lastCall.params).toEqual(['u-1', 'h', '2024-12-31T00:00:00.000Z']);
    expect(token.revokedAt).toBeNull();
  });

  it('finds by hash and revokes only non-revoked rows', async () => {
    const find = new FakeQueryable([{ rows: [] }]);
    expect(await findRefreshTokenByHash(find, 'h')).toBeNull();
    expect(find.lastCall.sql).toContain('WHERE token_hash = $1');

    const revoke = new FakeQueryable([{ rows: [] }]);
    expect(await revokeRefreshToken(revoke, 'h')).toBeNull();
    expect(revoke.lastCall.sql).toContain('revoked_at IS NULL');
  });
});

describe('article-topics repository', () => {
  it('associates many topics in one multi-row insert', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    await associateArticleTopics(db, 'art-1', [
      { topicId: 't-1', confidence: 0.9 },
      { topicId: 't-2', confidence: 0.5 },
    ]);
    const { sql, params } = db.lastCall;
    expect(sql).toContain('VALUES ($1, $2, $3), ($1, $4, $5)');
    expect(params).toEqual(['art-1', 't-1', 0.9, 't-2', 0.5]);
  });

  it('is a no-op for empty associations', async () => {
    const db = new FakeQueryable();
    expect(await associateArticleTopics(db, 'art-1', [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('findHighestConfidenceTopic orders by confidence and limits 1', async () => {
    const db = new FakeQueryable([
      { rows: [{ article_id: 'art-1', topic_id: 't-1', confidence: '0.9' }] },
    ]);
    const top = await findHighestConfidenceTopic(db, 'art-1');
    expect(db.lastCall.sql).toContain('ORDER BY confidence DESC, topic_id ASC');
    expect(db.lastCall.sql).toContain('LIMIT 1');
    expect(top?.confidence).toBeCloseTo(0.9);
  });
});

describe('user-embeddings repository', () => {
  it('returns null when there is no embedding row (fallback signal)', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await getUserEmbedding(db, 'u-1')).toBeNull();
  });

  it('upserts the embedding as a serialized vector', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            user_id: 'u-1',
            embedding: '[0.1,0.2,0.3]',
            updated_at: new Date('2024-06-01T00:00:00.000Z'),
          },
        ],
      },
    ]);
    const rec = await upsertUserEmbedding(db, 'u-1', [0.1, 0.2, 0.3]);
    expect(db.lastCall.sql).toContain('$2::vector');
    expect(db.lastCall.params).toEqual(['u-1', '[0.1,0.2,0.3]']);
    expect(rec.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('emerging-topics repository', () => {
  it('records idempotently and lists capped at the limit', async () => {
    const db = new FakeQueryable([
      { rows: [{ user_id: 'u-1', topic_id: 't-1', detected_at: new Date('2024-06-01T00:00:00.000Z') }] },
    ]);
    await recordEmergingTopic(db, 'u-1', 't-1');
    expect(db.lastCall.sql).toContain('ON CONFLICT (user_id, topic_id)');

    const list = new FakeQueryable([{ rows: [] }]);
    await listEmergingTopics(list, 'u-1');
    expect(list.lastCall.params).toEqual(['u-1', 3]);
  });

  it('deleteEmergingTopic returns null when none existed', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await deleteEmergingTopic(db, 'u-1', 't-x')).toBeNull();
    expect(db.lastCall.params).toEqual(['u-1', 't-x']);
  });
});

describe('crawl repository', () => {
  it('returns null state when a source has never crawled (backfill signal)', async () => {
    const db = new FakeQueryable([{ rows: [] }]);
    expect(await getCrawlState(db, 'wikipedia')).toBeNull();
  });

  it('upserts the last successful crawl timestamp', async () => {
    const db = new FakeQueryable([
      { rows: [{ source: 'wikipedia', last_successful_crawl_at: new Date('2024-06-01T00:00:00.000Z') }] },
    ]);
    const state = await updateLastSuccessfulCrawl(db, 'wikipedia', '2024-06-01T00:00:00.000Z');
    expect(db.lastCall.sql).toContain('ON CONFLICT (source) DO UPDATE');
    expect(db.lastCall.params).toEqual(['wikipedia', '2024-06-01T00:00:00.000Z']);
    expect(state.lastSuccessfulCrawlAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('records a crawl failure', async () => {
    const db = new FakeQueryable([
      { rows: [{ id: 'cf-1', source: 'arxiv', error: 'timeout', occurred_at: new Date('2024-06-01T00:00:00.000Z') }] },
    ]);
    const failure = await recordCrawlFailure(db, 'arxiv', 'timeout');
    expect(db.lastCall.params).toEqual(['arxiv', 'timeout']);
    expect(failure.error).toBe('timeout');
  });
});

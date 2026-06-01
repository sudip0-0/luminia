import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './app.js';
import { FakeQueryable, normalizeSql, type CannedResult } from './repositories/fake-queryable.js';
import {
  DEFAULT_DAILY_GOAL_MINUTES,
  DEFAULT_DEPTH_PREFERENCE,
} from './repositories/users.repository.js';
import { issueAccessToken } from './auth/tokens.js';
import type { FeedReturnedSet } from './feed/assembly.js';
import type { ArticleSearchClient } from './search/service.js';

// Verifies that authenticated routes (task 28.1) are mounted behind the
// access-token guard: a valid bearer token passes the guard and the handler
// delegates to the pure service and returns its data; the existing app.test.ts
// already covers the guard-rejects-everything path. Also covers the routes that
// require injected external clients (Feed → Redis, Search → Typesense).

const SECRET = 'test-secret';

const userRow: Record<string, unknown> = {
  id: 'u-1',
  email: 'reader@example.com',
  password_hash: 'stored-hash',
  display_name: 'Ada Reader',
  avatar_url: null,
  depth_preference: DEFAULT_DEPTH_PREFERENCE,
  daily_goal_minutes: DEFAULT_DAILY_GOAL_MINUTES,
  push_enabled: false,
  onboarding_completed_at: null,
  created_at: new Date(1_700_000_000_000),
};

const db = new FakeQueryable((sql): CannedResult => {
  const s = normalizeSql(sql);
  if (s.startsWith('UPDATE "user"')) return { rows: [{ ...userRow, push_enabled: true }] };
  if (s.startsWith('SELECT') && s.includes('"user"')) return { rows: [userRow] };
  if (s.includes('from user_topic')) return { rows: [] };
  return { rows: [] };
});

const fakeReturnedSet: FeedReturnedSet = {
  async getReturnedArticles() {
    return [];
  },
  async addReturnedArticles() {},
};

const fakeSearch: ArticleSearchClient = {
  async search() {
    return { hits: [], found: 0 };
  },
};

const app = buildApp({
  db,
  auth: { secret: SECRET, denylist: { isAccessTokenDenied: async () => false } },
  redis: fakeReturnedSet,
  search: fakeSearch,
});

const bearer = `Bearer ${issueAccessToken('u-1', { secret: SECRET }).token}`;
const authHeaders = { authorization: bearer };

afterAll(async () => {
  await app.close();
});

describe('authenticated routes', () => {
  it('returns the profile for a valid access token (GET /me)', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      displayName: 'Ada Reader',
      avatarUrl: null,
      depth: DEFAULT_DEPTH_PREFERENCE,
      dailyGoal: DEFAULT_DAILY_GOAL_MINUTES,
    });
  });

  it('rejects a missing token with the uniform AUTH_FAILED envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_FAILED');
  });

  it('returns the active feed tabs (GET /feed/tabs)', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed/tabs', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().tabs[0].key).toBe('foryou');
  });

  it('toggles notification preferences (PATCH /notifications/preferences)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/notifications/preferences',
      headers: authHeaders,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
  });

  it('rejects a non-boolean notification toggle', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/notifications/preferences',
      headers: authHeaders,
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('assembles a feed when Redis is injected (GET /feed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed?tab=foryou', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().articles)).toBe(true);
  });

  it('searches when a search client is injected (GET /search)', async () => {
    const res = await app.inject({ method: 'GET', url: '/search?q=physics', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('rejects an empty search query (GET /search)', async () => {
    const res = await app.inject({ method: 'GET', url: '/search?q=', headers: authHeaders });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns monthly insights (GET /insights/monthly)', async () => {
    const res = await app.inject({ method: 'GET', url: '/insights/monthly', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('articlesRead');
  });

  it('lists saved articles (GET /library/saves)', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/saves', headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('lists collections (GET /library/collections)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/library/collections',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('rejects an invalid read-state (PATCH /library/saves/:id/read-state)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/library/saves/a-1/read-state',
      headers: authHeaders,
      payload: { state: 'maybe' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './app.js';
import { FakeQueryable } from './repositories/fake-queryable.js';

const app = buildApp();

const taxonomyRow = {
  id: 't-1',
  slug: 'science',
  label: 'Science',
  parent_id: null,
  color: '#fff',
  icon_name: 'atom',
};

// An app wired with a fake DB (public routes) and an auth guard whose denylist
// always denies, so every authenticated route is rejected with AUTH_FAILED.
const wiredApp = buildApp({
  db: new FakeQueryable(() => ({ rows: [taxonomyRow] })),
  auth: {
    secret: 'test-secret',
    denylist: { isAccessTokenDenied: async () => true },
  },
});

afterAll(async () => {
  await app.close();
  await wiredApp.close();
});

describe('Backend API app', () => {
  it('responds to the health probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the uniform error envelope for an unmatched route', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('mounts public service routes when a db is provided', async () => {
    const res = await wiredApp.inject({ method: 'GET', url: '/onboarding/topics' });
    expect(res.statusCode).toBe(200);
    expect(res.json().topics).toHaveLength(1);
  });
});

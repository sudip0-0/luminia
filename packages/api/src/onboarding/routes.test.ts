import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { FakeQueryable } from '../repositories/fake-queryable.js';
import { onboardingRoutes } from './routes.js';

// Verifies the public taxonomy route adapter `GET /onboarding/topics`
// (Requirement 3.1) returns the taxonomy DTOs produced by the service.

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /onboarding/topics', () => {
  it('returns the mapped taxonomy with slug-based parent references', async () => {
    const db = new FakeQueryable([
      {
        rows: [
          {
            id: 'parent-1',
            slug: 'science',
            label: 'Science',
            parent_id: null,
            color: '#0a0a0a',
            icon_name: 'flask',
            centroid: null,
          },
          {
            id: 'child-1',
            slug: 'physics',
            label: 'Physics',
            parent_id: 'parent-1',
            color: '#112233',
            icon_name: 'atom',
            centroid: null,
          },
        ],
      },
    ]);

    app = Fastify();
    await app.register(onboardingRoutes({ db }));

    const res = await app.inject({ method: 'GET', url: '/onboarding/topics' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      topics: [
        {
          slug: 'science',
          label: 'Science',
          parentSlug: null,
          color: '#0a0a0a',
          iconName: 'flask',
        },
        {
          slug: 'physics',
          label: 'Physics',
          parentSlug: 'science',
          color: '#112233',
          iconName: 'atom',
        },
      ],
    });
  });
});

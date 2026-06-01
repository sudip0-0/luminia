// Onboarding_Service HTTP routes.
//
// Registers the public taxonomy endpoint `GET /onboarding/topics`
// (Requirement 3.1). The handler is a thin adapter over the pure
// `getTaxonomy(deps)` service so all taxonomy logic stays unit-testable without
// Fastify. Onboarding completion (`POST /onboarding/complete`) is implemented
// separately (task 5.2). Wiring this plugin into the app happens in a later
// task (28.1).

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { type Queryable } from '../repositories/queryable.js';
import { type TopicTaxonomyDto, getTaxonomy } from './taxonomy.js';

/** Dependencies injected into the onboarding routes. */
export interface OnboardingRoutesDeps {
  db: Queryable;
}

/** Response body for `GET /onboarding/topics`. */
export interface TaxonomyResponse {
  topics: TopicTaxonomyDto[];
}

/**
 * Fastify plugin exposing the public onboarding taxonomy endpoint. Pass the
 * shared {@link Queryable} so the handler delegates to the pure service.
 */
export function onboardingRoutes(
  deps: OnboardingRoutesDeps,
): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/onboarding/topics', async (): Promise<TaxonomyResponse> => {
      const topics = await getTaxonomy({ db: deps.db });
      return { topics };
    });
  };
}

import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { ERROR_CODES, makeError } from '@lumina/shared';

import type { Queryable } from './repositories/queryable.js';
import { makeAccessTokenGuard, type AccessTokenGuardDeps } from './auth/middleware.js';
import { onboardingRoutes } from './onboarding/routes.js';
import { authenticatedRoutes } from './authenticated-routes.js';
import type { FeedReturnedSet } from './feed/assembly.js';
import type { ArticleSearchClient } from './search/service.js';

/**
 * Dependencies for {@link buildApp}. All are optional so the bare app (with the
 * liveness probe and the uniform error envelope) can be built without external
 * services — e.g. in the existing app smoke test. When supplied, the service
 * route plugins are mounted: public routes (e.g. the onboarding taxonomy) at
 * the root, and authenticated routes behind the access-token guard.
 */
export interface AppDeps {
  /** Shared query surface (a live `pg` pool in production, a fake in tests). */
  db?: Queryable;
  /** Access-token guard dependencies; when present an authenticated scope is mounted. */
  auth?: AccessTokenGuardDeps;
  /** Redis returned-set; when present the authenticated Feed routes are mounted. */
  redis?: FeedReturnedSet;
  /** Typesense-backed search client; when present the authenticated Search route is mounted. */
  search?: ArticleSearchClient;
}

/**
 * Builds the Lumina Backend API Fastify instance (task 28.1).
 *
 * Cross-cutting wiring that every route sits behind:
 *   - a uniform error envelope `{ error: { code, message, details? } }` for both
 *     thrown errors and unmatched routes (the design's Error Handling section);
 *   - a liveness probe at `GET /health` (always public);
 *   - public service routes mounted at the root when {@link AppDeps.db} is given;
 *   - authenticated service routes mounted inside a scope guarded by the
 *     access-token middleware (Requirements 2.6, 26.4) when {@link AppDeps.auth}
 *     is given.
 *
 * The authenticated service routes (profile, article detail, topic mute/unmute,
 * events, library saves/listing/collections, feed tabs, insights, notification
 * preferences) are mounted by {@link authenticatedRoutes} inside
 * {@link registerAuthenticatedRoutes}. Feed assembly and Search additionally
 * require external clients (Redis, Typesense) and mount only when those are
 * injected via {@link AppDeps.redis} / {@link AppDeps.search}.
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  // Uniform error envelope for thrown errors. A Fastify validation error maps to
  // VALIDATION_ERROR (400); anything else maps to an INTERNAL 500 without
  // leaking internals.
  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error.validation) {
      await reply
        .code(400)
        .send(makeError(ERROR_CODES.VALIDATION_ERROR, 'Request failed validation', {
          issues: error.validation,
        }));
      return;
    }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.VALIDATION_ERROR;
    if (status >= 500) {
      app.log.error(error);
      await reply
        .code(500)
        .send(makeError(ERROR_CODES.VALIDATION_ERROR, 'Internal server error'));
      return;
    }
    await reply.code(status).send(makeError(code, error.message));
  });

  // Uniform envelope for unmatched routes.
  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(makeError(ERROR_CODES.NOT_FOUND, 'Route not found'));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Public service routes.
  if (deps.db) {
    void app.register(onboardingRoutes({ db: deps.db }));
  }

  // Authenticated service routes, all behind the access-token guard.
  if (deps.auth) {
    void app.register(registerAuthenticatedRoutes(deps.auth, deps));
  }

  return app;
}

/**
 * Build the authenticated route scope: an encapsulated Fastify plugin that
 * installs the access-token guard as a `preHandler` so every route registered
 * within it is protected (Requirements 2.6, 26.4). Per-service authenticated
 * route plugins are registered inside this scope as they are wired.
 */
function registerAuthenticatedRoutes(authDeps: AccessTokenGuardDeps, deps: AppDeps) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.addHook('preHandler', makeAccessTokenGuard(authDeps));
    // Authenticated service plugins. db-only routes (profile, article detail,
    // topic mute/unmute, events, library saves, feed tabs, notification
    // preferences) always mount; Feed assembly and Search mount when their
    // external clients (Redis, Typesense) are injected.
    if (deps.db) {
      await scope.register(
        authenticatedRoutes({ db: deps.db, redis: deps.redis, search: deps.search }),
      );
    }
  };
}

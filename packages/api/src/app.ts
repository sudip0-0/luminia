import Fastify, {
  type FastifyInstance,
  type FastifyError,
  type FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, makeError } from '@lumina/shared';

import type { Queryable } from './repositories/queryable.js';
import { makeAccessTokenGuard, type AccessTokenGuardDeps } from './auth/middleware.js';
import { authRoutes, type AuthRoutesDeps } from './auth/routes.js';
import { onboardingRoutes } from './onboarding/routes.js';
import { authenticatedRoutes } from './authenticated-routes.js';
import type { FeedReturnedSet } from './feed/assembly.js';
import type { ArticleSearchClient } from './search/service.js';
import type { ReadinessDeps } from './ready.js';
import { checkReadiness } from './ready.js';

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
  /** Public auth routes (register/login/refresh/oauth/logout). */
  authRoutes?: AuthRoutesDeps;
  /** Redis returned-set; when present the authenticated Feed routes are mounted. */
  redis?: FeedReturnedSet;
  /** Typesense-backed search client; when present the authenticated Search route is mounted. */
  search?: ArticleSearchClient;
  /** Optional readiness probe dependencies (DB/Redis/Typesense). */
  readiness?: ReadinessDeps;
  /** Disable request-id generation (tests can leave default). */
  genRequestId?: () => string;
}

/**
 * Builds the Lumina Backend API Fastify instance.
 *
 * Cross-cutting wiring that every route sits behind:
 *   - structured logging with a per-request `requestId`;
 *   - a uniform error envelope `{ error: { code, message, details? } }`;
 *   - liveness at `GET /health` and readiness at `GET /ready`;
 *   - public auth + onboarding routes when deps are supplied;
 *   - authenticated routes behind the access-token guard.
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const genRequestId = deps.genRequestId ?? (() => randomUUID());

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => genRequestId(),
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.log = request.log.child({ requestId: request.id });
  });

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
    // @fastify/rate-limit uses 429
    if (error.statusCode === 429) {
      await reply
        .code(429)
        .send(makeError(ERROR_CODES.RATE_LIMITED, 'Too many requests'));
      return;
    }
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) {
      app.log.error(error);
      await reply
        .code(500)
        .send(makeError(ERROR_CODES.INTERNAL, 'Internal server error'));
      return;
    }
    const code = status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.VALIDATION_ERROR;
    await reply.code(status).send(makeError(code, error.message));
  });

  // Uniform envelope for unmatched routes.
  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(makeError(ERROR_CODES.NOT_FOUND, 'Route not found'));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    if (!deps.readiness) {
      return { status: 'ok', checks: { configured: false } };
    }
    const result = await checkReadiness(deps.readiness);
    if (!result.ok) {
      return reply.code(503).send(result);
    }
    return result;
  });

  // Public auth routes (register/login/refresh/oauth/logout).
  if (deps.authRoutes) {
    void app.register(authRoutes(deps.authRoutes));
  }

  // Public onboarding taxonomy (completion is authenticated).
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
 * within it is protected (Requirements 2.6, 26.4).
 */
function registerAuthenticatedRoutes(authDeps: AccessTokenGuardDeps, deps: AppDeps) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.addHook('preHandler', makeAccessTokenGuard(authDeps));
    if (deps.db) {
      await scope.register(
        authenticatedRoutes({ db: deps.db, redis: deps.redis, search: deps.search }),
      );
    }
  };
}

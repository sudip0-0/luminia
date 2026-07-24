// Auth_Service HTTP routes — public register/login/refresh/oauth and logout.
//
// Thin Fastify adapters over the pure auth services. Rate-limited on the
// credential endpoints. OAuth uses an injectable {@link OAuthVerifier} map so
// tests supply fakes and production can plug real IdP verifiers without
// changing route code.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { ERROR_CODES, makeError, type ApiErrorEnvelope } from '@lumina/shared';

import type { Queryable } from '../repositories/queryable.js';
import type { OAuthProvider } from '../repositories/types.js';
import {
  makeAccessTokenGuard,
  type AccessTokenGuardDeps,
} from './middleware.js';
import {
  register,
  registerOAuth,
  type OAuthVerifier,
  type RegisterOAuthDeps,
} from './register.js';
import {
  login,
  logout,
  refresh,
  type LoginLockoutStore,
} from './session.js';
import type { AccessTokenDenylist, TokenOptions } from './tokens.js';

/** Dependencies for the public auth routes plugin. */
export interface AuthRoutesDeps {
  db: Queryable;
  redis: LoginLockoutStore & Pick<AccessTokenDenylist, 'denyAccessToken' | 'isAccessTokenDenied'>;
  /** Access-token signing/verification options. */
  tokenOptions?: TokenOptions;
  /**
   * Per-provider OAuth verifiers. Missing providers yield a validation error.
   * Tests inject fakes; production wires real IdP verifiers.
   */
  oauthVerifiers?: Partial<Record<OAuthProvider, OAuthVerifier>>;
  /**
   * When true, skip @fastify/rate-limit registration (unit tests). Production
   * bootstrap leaves this undefined/false.
   */
  disableRateLimit?: boolean;
}

function statusForError(envelope: ApiErrorEnvelope): number {
  switch (envelope.error.code) {
    case 'AUTH_FAILED':
      return 401;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}

function sendError(reply: FastifyReply, envelope: ApiErrorEnvelope): FastifyReply {
  return reply.code(statusForError(envelope)).send(envelope);
}

function sessionBody(session: {
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}) {
  return {
    userId: session.userId,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
  };
}

/**
 * Public auth routes plugin. Mounts register/login/refresh/oauth at the root
 * and logout behind an access-token guard registered on the same plugin scope.
 */
export function authRoutes(deps: AuthRoutesDeps): FastifyPluginAsync {
  const { db, redis, tokenOptions, oauthVerifiers = {} } = deps;

  return async (app: FastifyInstance): Promise<void> => {
    if (!deps.disableRateLimit) {
      const rateLimit = await import('@fastify/rate-limit');
      await app.register(rateLimit.default, {
        max: 30,
        timeWindow: '1 minute',
        hook: 'preHandler',
      });
    }

    app.post('/auth/register', async (request, reply) => {
      const body = (request.body ?? {}) as {
        email?: string;
        password?: string;
        dailyGoal?: number;
        depth?: string;
      };
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, 'email and password are required.'),
        );
      }
      const result = await register(
        { db, tokenOptions },
        {
          email: body.email,
          password: body.password,
          dailyGoal: body.dailyGoal,
          depth: body.depth as never,
        },
      );
      if (!result.ok) return sendError(reply, result.error);
      return reply.code(201).send(sessionBody(result.session));
    });

    app.post('/auth/login', async (request, reply) => {
      const body = (request.body ?? {}) as { email?: string; password?: string };
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, 'email and password are required.'),
        );
      }
      const result = await login(
        { db, redis, tokenOptions },
        { email: body.email, password: body.password },
      );
      if (!result.ok) return sendError(reply, result.error);
      return sessionBody(result.session);
    });

    app.post('/auth/refresh', async (request, reply) => {
      const body = (request.body ?? {}) as { refreshToken?: string };
      if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, 'refreshToken is required.'),
        );
      }
      const result = await refresh(
        { db, tokenOptions },
        { refreshToken: body.refreshToken },
      );
      if (!result.ok) return sendError(reply, result.error);
      return {
        accessToken: result.accessToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt,
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      };
    });

    app.post('/auth/oauth/:provider', async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const body = (request.body ?? {}) as { providerToken?: string };
      if (typeof body.providerToken !== 'string' || body.providerToken.length === 0) {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, 'providerToken is required.'),
        );
      }
      const verifier = oauthVerifiers[provider as OAuthProvider];
      if (!verifier) {
        return sendError(
          reply,
          makeError(ERROR_CODES.VALIDATION_ERROR, 'Unsupported OAuth provider.', {
            provider,
          }),
        );
      }
      const oauthDeps: RegisterOAuthDeps = { db, tokenOptions, verifier };
      const result = await registerOAuth(oauthDeps, {
        provider,
        providerToken: body.providerToken,
      });
      if (!result.ok) return sendError(reply, result.error);
      return reply.code(200).send({
        ...sessionBody(result.session),
        outcome: result.outcome,
      });
    });

    // Logout requires a valid access token.
    const guardDeps: AccessTokenGuardDeps = {
      denylist: redis,
      ...tokenOptions,
    };
    app.post(
      '/auth/logout',
      { preHandler: makeAccessTokenGuard(guardDeps) },
      async (request, reply) => {
        const body = (request.body ?? {}) as { refreshToken?: string };
        const claims = request.auth!;
        await logout(
          { db, redis, now: tokenOptions?.now },
          {
            accessTokenClaims: claims,
            refreshToken:
              typeof body.refreshToken === 'string' ? body.refreshToken : undefined,
          },
        );
        return reply.code(204).send();
      },
    );
  };
}

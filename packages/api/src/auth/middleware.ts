// Access-token verification middleware (Fastify preHandler).
//
// A single guard protects every authenticated route: it pulls the bearer token
// from the `Authorization` header, verifies signature + expiry, and checks the
// `jti` against the Redis denylist. Any failure — missing, malformed, expired,
// or denylisted — is answered with the SAME generic `401 AUTH_FAILED` body so
// the response never reveals why the token was rejected (Requirements 2.6,
// 26.4). On success the verified claims are attached to `request.auth` for
// downstream handlers.

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import {
  type AccessTokenClaims,
  type AccessTokenDenylist,
  type TokenOptions,
  authorizationError,
  extractBearerToken,
  verifyAccessToken,
} from './tokens.js';

/** Augment Fastify's request with the verified access-token claims. */
declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after the access-token guard has run successfully. */
    auth?: AccessTokenClaims;
  }
}

/** Dependencies for the access-token guard. */
export interface AccessTokenGuardDeps extends TokenOptions {
  /** The Redis-backed `jti` denylist (e.g. a {@link RedisKeyStore}). */
  denylist: Pick<AccessTokenDenylist, 'isAccessTokenDenied'>;
}

/**
 * Build a Fastify `preHandler` that authenticates the request via its bearer
 * access token. Rejects with the uniform `401 AUTH_FAILED` envelope on any
 * verification failure; otherwise attaches {@link AccessTokenClaims} to
 * `request.auth` and lets the request proceed.
 */
export function makeAccessTokenGuard(
  deps: AccessTokenGuardDeps,
): preHandlerHookHandler {
  const { denylist, ...tokenOptions } = deps;

  return async function accessTokenGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    const result = await verifyAccessToken(denylist, token, tokenOptions);

    if (!result.ok) {
      await reply.code(401).send(authorizationError());
      return;
    }

    request.auth = result.claims;
  };
}

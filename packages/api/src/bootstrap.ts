// Production composition root — wires Pool, Redis, Typesense, and auth into
// {@link buildApp}. Importing this module performs no I/O until {@link bootstrap}
// is called.

import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { Client as TypesenseClient } from 'typesense';

import { buildApp, type AppDeps } from './app.js';
import { getAccessTokenSecret } from './auth/config.js';
import type { OAuthVerifier } from './auth/register.js';
import type { OAuthProvider } from './repositories/types.js';
import { fromPool } from './repositories/queryable.js';
import {
  createRedisConnection,
  ioredisAdapter,
  RedisKeyStore,
} from './redis/client.js';
import { createTypesenseClient } from './typesense/client.js';
import type { ArticleSearchClient } from './search/service.js';
import { ARTICLES_COLLECTION_NAME } from './typesense/schema.js';
import { startTelemetry } from './telemetry.js';

export interface BootstrapResult {
  app: FastifyInstance;
  pool: Pool;
  redis: ReturnType<typeof createRedisConnection>;
  redisStore: RedisKeyStore;
  close: () => Promise<void>;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** Override OAuth verifiers (defaults to empty — routes reject unknown providers). */
  oauthVerifiers?: Partial<Record<OAuthProvider, OAuthVerifier>>;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function buildTypesenseSearchClient(client: TypesenseClient): ArticleSearchClient {
  return {
    async search(params) {
      const response = await client
        .collections(ARTICLES_COLLECTION_NAME)
        .documents()
        .search({
          q: params.q,
          query_by: params.query_by,
          sort_by: params.sort_by,
          page: params.page,
          per_page: params.per_page,
          ...(params.filter_by !== undefined
            ? { filter_by: params.filter_by }
            : {}),
        });
      return {
        hits: (response.hits ?? []).map((hit) => ({
          document: hit.document as never,
          text_match: hit.text_match,
        })),
        found: response.found,
      };
    },
  };
}

function typesenseHealth(client: TypesenseClient): {
  healthy: () => Promise<boolean>;
} {
  return {
    async healthy() {
      const health = await client.health.retrieve();
      return health.ok === true;
    },
  };
}

/**
 * Compose production dependencies and build the Fastify app.
 * Fails closed when required env vars (including the access-token secret) are missing.
 */
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const env = options.env ?? process.env;
  startTelemetry(env);

  const databaseUrl = requireEnv(env, 'DATABASE_URL');
  const redisUrl = env.REDIS_URL;
  const secret = getAccessTokenSecret(env);

  const pool = new Pool({ connectionString: databaseUrl });
  const db = fromPool(pool);

  const redis = createRedisConnection(
    redisUrl
      ? ({
          host: new URL(redisUrl).hostname,
          port: Number(new URL(redisUrl).port || 6379),
          ...(new URL(redisUrl).password
            ? { password: decodeURIComponent(new URL(redisUrl).password) }
            : {}),
        } as const)
      : undefined,
  );
  const redisStore = new RedisKeyStore(ioredisAdapter(redis));

  let search: ArticleSearchClient | undefined;
  let typesenseReady: { healthy: () => Promise<boolean> } | undefined;
  const typesenseHost = env.TYPESENSE_HOST;
  const typesenseApiKey = env.TYPESENSE_API_KEY;
  if (typesenseHost && typesenseApiKey) {
    const client = createTypesenseClient({
      nodes: [
        {
          host: typesenseHost,
          port: Number(env.TYPESENSE_PORT ?? 8108),
          protocol: env.TYPESENSE_PROTOCOL ?? 'http',
        },
      ],
      apiKey: typesenseApiKey,
      connectionTimeoutSeconds: 5,
    });
    search = buildTypesenseSearchClient(client);
    typesenseReady = typesenseHealth(client);
  }

  const appDeps: AppDeps = {
    db,
    auth: { secret, denylist: redisStore },
    authRoutes: {
      db,
      redis: redisStore,
      tokenOptions: { secret },
      oauthVerifiers: options.oauthVerifiers ?? {},
    },
    redis: redisStore,
    search,
    readiness: {
      db,
      redis: {
        async ping() {
          return redis.ping();
        },
      },
      typesense: typesenseReady,
    },
  };

  const app = buildApp(appDeps);

  return {
    app,
    pool,
    redis,
    redisStore,
    close: async () => {
      await app.close();
      await redis.quit();
      await pool.end();
    },
  };
}

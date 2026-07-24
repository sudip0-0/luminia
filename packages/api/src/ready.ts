// Readiness probe — checks downstream dependencies without leaking internals.

import type { Queryable } from './repositories/queryable.js';

/** Narrow Redis surface for readiness (PING). */
export interface ReadyRedis {
  ping(): Promise<string>;
}

/** Narrow Typesense surface for readiness. */
export interface ReadyTypesense {
  healthy(): Promise<boolean>;
}

/** Dependencies probed by {@link checkReadiness}. */
export interface ReadinessDeps {
  db: Queryable;
  redis: ReadyRedis;
  typesense?: ReadyTypesense;
}

export interface ReadinessResult {
  ok: boolean;
  status: 'ok' | 'not_ready';
  checks: {
    postgres: boolean;
    redis: boolean;
    typesense: boolean | 'skipped';
  };
}

/**
 * Probe Postgres, Redis, and (when configured) Typesense. Returns `ok: false`
 * when any required check fails.
 */
export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const checks: ReadinessResult['checks'] = {
    postgres: false,
    redis: false,
    typesense: deps.typesense ? false : 'skipped',
  };

  try {
    await deps.db.query('SELECT 1');
    checks.postgres = true;
  } catch {
    checks.postgres = false;
  }

  try {
    const pong = await deps.redis.ping();
    checks.redis = pong.toUpperCase() === 'PONG' || pong === 'OK' || pong.length > 0;
  } catch {
    checks.redis = false;
  }

  if (deps.typesense) {
    try {
      checks.typesense = await deps.typesense.healthy();
    } catch {
      checks.typesense = false;
    }
  }

  const ok =
    checks.postgres &&
    checks.redis &&
    (checks.typesense === 'skipped' || checks.typesense === true);

  return {
    ok,
    status: ok ? 'ok' : 'not_ready',
    checks,
  };
}

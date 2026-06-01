// Onboarding_Service — onboarding completion (Requirements 3.2-3.7).
//
// `completeOnboarding` validates an onboarding submission and, only when every
// validation passes, persists the user's initial preferences as a single
// all-or-nothing unit:
//
//   - topic count must be in [3, 20]                         (Requirement 3.2)
//   - every selected topic id must reference an existing Topic (Requirement 3.3)
//   - depth ∈ {quick, balanced, deep} and Daily_Goal ∈ [5,120] (Requirement 3.4)
//   - on success: persist each DISTINCT topic with
//     `source = onboarding`, `weight = 1.0`                  (Requirement 3.5)
//   - store the Depth_Preference and Daily_Goal on the user  (Requirement 3.6)
//   - persist the enabled/disabled state of each provided Source (Requirement 3.7)
//
// All-or-nothing: on ANY validation failure the function returns a uniform
// validation error envelope and persists nothing (no DB read is a write, and
// the writes only run after every check has passed). The writes themselves run
// through an injected `transact` unit so a partial failure rolls the whole
// submission back. The function is intentionally decoupled from Fastify — it
// takes its database handle (and optional transaction runner) as dependencies
// so it is fully unit-testable with an in-memory FakeQueryable; the HTTP route
// adapter is wired in a later task.

import {
  SOURCES,
  type ApiErrorEnvelope,
  type Depth,
  type Source,
  ERROR_CODES,
  makeError,
  validateDailyGoal,
  validateDepth,
} from '@lumina/shared';
import { type Queryable } from '../repositories/queryable.js';
import { findTopicsByIds } from '../repositories/topics.repository.js';
import { upsertUserTopic } from '../repositories/user-topics.repository.js';
import { setUserSourceEnabled } from '../repositories/user-sources.repository.js';
import { updateUserProfile } from '../repositories/users.repository.js';

/** Inclusive lower bound on the number of selected topics (Requirement 3.2). */
export const MIN_ONBOARDING_TOPICS = 3;
/** Inclusive upper bound on the number of selected topics (Requirement 3.2). */
export const MAX_ONBOARDING_TOPICS = 20;
/** Initial weight assigned to every onboarding topic (Requirement 3.5). */
export const ONBOARDING_TOPIC_WEIGHT = 1.0;

/**
 * Per-source enabled/disabled selection (Requirement 3.7). A partial map keyed
 * by {@link Source}; only the sources present are persisted. Absent sources are
 * left untouched (the Mobile_App enables all six by default — Requirement 4.4).
 */
export type OnboardingSources = Partial<Record<Source, boolean>>;

/** The validated onboarding submission. */
export interface CompleteOnboardingInput {
  /** Selected topic ids; must be 3-20 entries, each an existing Topic. */
  topicIds: readonly string[];
  /** Reading depth preference; must be quick | balanced | deep. */
  depth: Depth;
  /** Daily reading goal in minutes; must be an integer in [5, 120]. */
  dailyGoal: number;
  /** Optional per-source enabled state to persist. */
  sources?: OnboardingSources;
}

/**
 * A function that runs `fn` as a single atomic unit (e.g. a PostgreSQL
 * transaction), passing it the transactional {@link Queryable}. Supplying this
 * makes the onboarding writes all-or-nothing at the database level: if any
 * write throws, the whole unit rolls back.
 */
export type Transactor = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

/** Dependencies for {@link completeOnboarding}. */
export interface CompleteOnboardingDeps {
  /** Database handle used for validation reads and (by default) writes. */
  db: Queryable;
  /**
   * Optional atomic unit for the writes. When omitted, writes run directly on
   * {@link db} (acceptable for unit tests; production wiring supplies a real
   * transaction so partial failures persist nothing).
   */
  transact?: Transactor;
  /** Clock for the `onboarding_completed_at` stamp; defaults to the wall clock. */
  now?: () => Date;
}

/** What was persisted on a successful completion. */
export interface OnboardingPersisted {
  /** The DISTINCT topic ids persisted, in first-seen order (Requirement 3.5). */
  topicIds: string[];
  /** The stored Depth_Preference (Requirement 3.6). */
  depth: Depth;
  /** The stored Daily_Goal in minutes (Requirement 3.6). */
  dailyGoalMinutes: number;
  /** The per-source enabled state persisted (Requirement 3.7). */
  sources: OnboardingSources;
  /** ISO-8601 completion timestamp recorded on the user. */
  onboardingCompletedAt: string;
}

/**
 * The discriminated outcome of {@link completeOnboarding}: either the
 * submission was persisted (`completed`) or it failed validation
 * (`validation-error`) and nothing was persisted. The route adapter maps
 * `completed` to `200` and `validation-error` to `400` with the envelope body.
 */
export type CompleteOnboardingResult =
  | { status: 'completed'; persisted: OnboardingPersisted }
  | { status: 'validation-error'; error: ApiErrorEnvelope };

/** Wrap a uniform validation-error envelope as the failure result. */
function validationError(
  message: string,
  details?: unknown,
): CompleteOnboardingResult {
  return {
    status: 'validation-error',
    error: makeError(ERROR_CODES.VALIDATION_ERROR, message, details),
  };
}

/** Run `fn` inside the injected transaction, or directly on `db` when absent. */
async function runAtomic<T>(
  deps: CompleteOnboardingDeps,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return deps.transact ? deps.transact(fn) : fn(deps.db);
}

/**
 * Validate and persist an onboarding submission as an all-or-nothing unit
 * (Requirements 3.2-3.7).
 *
 * Validation runs first and performs no writes, so any failure leaves stored
 * state untouched:
 *   1. topic count outside [3, 20]            → validation error (3.2)
 *   2. invalid depth or out-of-range goal      → validation error (3.4)
 *   3. malformed source toggle (unknown source or non-boolean state) → error (3.7-defensive)
 *   4. any unrecognized topic id               → validation error (3.3)
 *
 * On success it persists, within {@link runAtomic}:
 *   - each DISTINCT topic with `source = onboarding`, `weight = 1.0` (3.5)
 *   - the per-source enabled state (3.7)
 *   - the Depth_Preference, Daily_Goal, and completion timestamp on the
 *     user (3.6)
 *
 * The success payload is derived from the validated inputs (the DISTINCT topic
 * set, depth, goal, sources, and timestamp), not from the write results.
 */
export async function completeOnboarding(
  deps: CompleteOnboardingDeps,
  userId: string,
  input: CompleteOnboardingInput,
): Promise<CompleteOnboardingResult> {
  const { topicIds, depth, dailyGoal, sources } = input;

  // (3.2) Topic count must be within [3, 20] selected identifiers.
  if (
    topicIds.length < MIN_ONBOARDING_TOPICS ||
    topicIds.length > MAX_ONBOARDING_TOPICS
  ) {
    return validationError(
      `Between ${MIN_ONBOARDING_TOPICS} and ${MAX_ONBOARDING_TOPICS} topics are required.`,
      { field: 'topicIds', count: topicIds.length },
    );
  }

  // (3.4) Depth and Daily_Goal must be valid. Identify each invalid field.
  const invalidFields: string[] = [];
  if (!validateDepth(depth)) invalidFields.push('depth');
  if (!validateDailyGoal(dailyGoal)) invalidFields.push('dailyGoal');
  if (invalidFields.length > 0) {
    return validationError(
      'Invalid Depth_Preference or Daily_Goal.',
      { fields: invalidFields },
    );
  }

  // (3.7, defensive) A provided source toggle must reference a known Source
  // with a boolean state, otherwise the all-or-nothing unit would fail at the
  // database enum. Entries explicitly set to `undefined` are treated as absent.
  const providedSources = Object.entries(sources ?? {}).filter(
    ([, enabled]) => enabled !== undefined,
  ) as [string, boolean][];
  const invalidSourceKeys = providedSources
    .filter(
      ([key, enabled]) =>
        !(SOURCES as readonly string[]).includes(key) ||
        typeof enabled !== 'boolean',
    )
    .map(([key]) => key);
  if (invalidSourceKeys.length > 0) {
    return validationError('Unrecognized source toggle(s).', {
      field: 'sources',
      invalidSources: invalidSourceKeys,
    });
  }

  // De-duplicate the selected topics, preserving first-seen order (3.5).
  const distinctTopicIds = [...new Set(topicIds)];

  // (3.3) Every DISTINCT topic id must reference an existing Topic. This is a
  // read; it persists nothing, so a failure here keeps all-or-nothing intact.
  const existingTopics = await findTopicsByIds(deps.db, distinctTopicIds);
  const existingIds = new Set(existingTopics.map((topic) => topic.id));
  const unrecognized = distinctTopicIds.filter((id) => !existingIds.has(id));
  if (unrecognized.length > 0) {
    return validationError('One or more topic identifiers are unrecognized.', {
      field: 'topicIds',
      unrecognizedTopicIds: unrecognized,
    });
  }

  // All validations passed — persist atomically (3.5, 3.6, 3.7).
  const onboardingCompletedAt = (deps.now?.() ?? new Date()).toISOString();
  await runAtomic(deps, async (tx) => {
    for (const topicId of distinctTopicIds) {
      await upsertUserTopic(tx, userId, {
        topicId,
        weight: ONBOARDING_TOPIC_WEIGHT,
        source: 'onboarding',
      });
    }
    for (const [source, enabled] of providedSources) {
      await setUserSourceEnabled(tx, userId, source as Source, enabled);
    }
    await updateUserProfile(tx, userId, {
      depthPreference: depth,
      dailyGoalMinutes: dailyGoal,
      onboardingCompletedAt,
    });
  });

  const persistedSources: OnboardingSources = {};
  for (const [source, enabled] of providedSources) {
    persistedSources[source as Source] = enabled;
  }

  return {
    status: 'completed',
    persisted: {
      topicIds: distinctTopicIds,
      depth,
      dailyGoalMinutes: dailyGoal,
      sources: persistedSources,
      onboardingCompletedAt,
    },
  };
}

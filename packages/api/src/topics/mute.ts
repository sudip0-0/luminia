// Feed_Service — topic mute / unmute persistence.
//
// Implements the design's Feed_Service `muteTopic` / `unmuteTopic` behaviours
// (Requirements 25.2-25.6) behind the `POST /topics/{id}/mute` and
// `POST /topics/{id}/unmute` endpoints:
//   - `muteTopic` persists `muted = true` for the user's association with the
//     topic. The write is idempotent: re-muting an already-muted topic
//     preserves the muted state and still returns a success acknowledgement
//     (Requirements 25.3, 25.4, 25.5).
//   - `unmuteTopic` persists `muted = false`. It is likewise idempotent:
//     unmuting a topic that is not currently muted preserves the unmuted state
//     and returns success (Requirements 25.4, 25.5).
//   - Either call returns a uniform NOT_FOUND envelope when the topic is not
//     associated with the user — i.e. there is no `user_topic` row — without
//     mutating any state (Requirement 25.6).
//
// The exclusion of muted-topic articles from feed responses (Requirement 25.2)
// is implemented in feed candidate resolution (`feed/candidates.ts`, which
// reads the muted flag via `listMutedTopicIds`). This service is the single
// authority for the persisted muted flag that path reads, so muting here
// excludes the topic's articles from the current and all subsequent feed
// sessions until it is unmuted, and vice versa.
//
// All database access is injected behind {@link TopicMuteDataAccess}, whose
// production implementation ({@link createTopicMuteDataAccess}) wires the
// user-topics repository over a `Queryable`. Unit tests construct it over a
// `FakeQueryable`, so the service is fully exercisable without a live database.

import type { ApiErrorEnvelope } from '@lumina/shared';
import { ERROR_CODES, makeError } from '@lumina/shared';
import {
  setUserTopicMuted,
  type Queryable,
  type UserTopicRecord,
} from '../repositories/index.js';

/**
 * The persisted muted state of a user's topic association after a successful
 * mute/unmute, returned in the success acknowledgement.
 */
export interface TopicMuteState {
  topicId: string;
  /** `true` after {@link muteTopic}, `false` after {@link unmuteTopic}. */
  muted: boolean;
}

/** The discriminated outcome of a {@link muteTopic} / {@link unmuteTopic} call. */
export type TopicMuteResult =
  /** The association exists; `topic` carries the persisted muted state. */
  | { status: 'ok'; topic: TopicMuteState }
  /** No such association for the user; `error` is the uniform NOT_FOUND envelope. */
  | { status: 'not-found'; error: ApiErrorEnvelope };

/**
 * The narrow data-access surface the mute service depends on. Keeping it an
 * interface (rather than a `Queryable` directly) lets the persistence be
 * exercised independently of the rest of the Feed_Service. The production
 * implementation is {@link createTopicMuteDataAccess}.
 */
export interface TopicMuteDataAccess {
  /**
   * Set the muted state for an existing user-topic association, returning the
   * updated record. Returns `null` when the topic is not associated with the
   * user (no `user_topic` row), which the service turns into NOT_FOUND
   * (Requirement 25.6). The underlying UPDATE assigns the muted value
   * unconditionally, so re-applying the same state is an idempotent no-op that
   * still returns the row (Requirements 25.4, 25.5).
   */
  setMuted(
    userId: string,
    topicId: string,
    muted: boolean,
  ): Promise<UserTopicRecord | null>;
}

/**
 * Wire {@link TopicMuteDataAccess} to the user-topics repository over a
 * `Queryable`. Production code passes a live `pg`-backed `Queryable` (via
 * `fromPool`); unit tests pass a `FakeQueryable`.
 */
export function createTopicMuteDataAccess(db: Queryable): TopicMuteDataAccess {
  return {
    setMuted: (userId, topicId, muted) =>
      setUserTopicMuted(db, userId, topicId, muted),
  };
}

/** Build the uniform NOT_FOUND envelope for a topic not associated with the user. */
function topicNotFound(topicId: string): ApiErrorEnvelope {
  return makeError(ERROR_CODES.NOT_FOUND, 'Topic not found for user', { topicId });
}

/**
 * Persist `muted` for the user's association with `topicId` and build the
 * discriminated result. Shared by {@link muteTopic} and {@link unmuteTopic}:
 * a present association yields an idempotent success carrying the persisted
 * state; an absent association yields NOT_FOUND with no state change
 * (Requirement 25.6).
 */
async function setMutedState(
  deps: TopicMuteDataAccess,
  userId: string,
  topicId: string,
  muted: boolean,
): Promise<TopicMuteResult> {
  const record = await deps.setMuted(userId, topicId, muted);
  if (!record) {
    return { status: 'not-found', error: topicNotFound(topicId) };
  }
  return { status: 'ok', topic: { topicId: record.topicId, muted: record.muted } };
}

/**
 * Mute a topic for a user: persist `muted = true` (Requirements 25.3, 25.5).
 * Re-muting an already-muted topic preserves the muted state and returns
 * success (Requirement 25.4). Returns NOT_FOUND when the topic is not
 * associated with the user (Requirement 25.6).
 */
export function muteTopic(
  deps: TopicMuteDataAccess,
  userId: string,
  topicId: string,
): Promise<TopicMuteResult> {
  return setMutedState(deps, userId, topicId, true);
}

/**
 * Unmute a topic for a user: persist `muted = false` (Requirements 25.4, 25.5).
 * Unmuting a topic that is not currently muted preserves the unmuted state and
 * returns success (Requirement 25.5). Returns NOT_FOUND when the topic is not
 * associated with the user (Requirement 25.6).
 */
export function unmuteTopic(
  deps: TopicMuteDataAccess,
  userId: string,
  topicId: string,
): Promise<TopicMuteResult> {
  return setMutedState(deps, userId, topicId, false);
}

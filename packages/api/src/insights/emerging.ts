// Insights_Service — emerging interests, acceptance, and the feed-evolution
// narrative (Requirements 24.4, 24.5, 24.6, 24.7, 24.9, 24.10).
//
//   - getEmergingInterests: up to 3 detected emerging topics that the user has
//     not yet explicitly added (Requirements 24.4, 24.9 — empty when none).
//   - acceptEmergingInterest: accepting a topic that is in the user's emerging
//     list adds it with `source = inferred` and removes it from the list
//     (Requirement 24.5); accepting a topic that is NOT in the list returns a
//     not-found error and leaves state unchanged (Requirement 24.6).
//   - getFeedEvolutionNarrative: a 1-3 sentence narrative describing the shift
//     in the user's reading attention (Requirement 24.7), or an
//     insufficient-history narrative when the user has no reading history
//     (Requirement 24.10).
//
// DB access stays behind the repository layer over the narrow `Queryable`
// interface, so every function is unit-testable with an in-memory `FakeQueryable`.

import { ERROR_CODES, makeError, type ApiErrorEnvelope } from '@lumina/shared';

import type { Queryable } from '../repositories/queryable.js';
import {
  listEmergingTopics,
  findEmergingTopic,
  deleteEmergingTopic,
} from '../repositories/emerging-topics.repository.js';
import { listUserTopics, upsertUserTopic } from '../repositories/user-topics.repository.js';
import { listFeedEventsInWindow } from '../repositories/feed-events.repository.js';
import { getTopicBreakdown } from './topics.js';

/** Maximum emerging interests returned (Requirement 24.4). */
const MAX_EMERGING_INTERESTS = 3;

/** Initial interest weight for an accepted (inferred) topic, matching onboarding's 1.0. */
const INFERRED_TOPIC_WEIGHT = 1.0;

/** The earliest possible window lower bound for the full-history reading query. */
const EPOCH_ISO = new Date(0).toISOString();

/** A single emerging interest topic (Requirement 24.4). */
export interface EmergingInterest {
  topicId: string;
}

/** The result of accepting an emerging interest (Requirements 24.5, 24.6). */
export type AcceptEmergingResult =
  | { ok: true; topicId: string }
  | { ok: false; error: ApiErrorEnvelope };

/** The feed-evolution narrative (Requirements 24.7, 24.10). */
export interface FeedEvolutionNarrative {
  /** 1-3 sentences describing the shift in reading attention. */
  narrative: string;
  /** Whether the user has any reading history (false ⇒ insufficient-history copy). */
  hasHistory: boolean;
}

/** Dependencies for the emerging-interests functions: only a database handle. */
export interface EmergingInterestsDeps {
  db: Queryable;
}

/**
 * Return up to 3 detected emerging topics the user has not yet explicitly added
 * (Requirements 24.4, 24.9). Emerging topics already present in the user's
 * topics are excluded; the most-recently-detected eligible topics are returned.
 */
export async function getEmergingInterests(
  deps: EmergingInterestsDeps,
  userId: string,
): Promise<EmergingInterest[]> {
  const { db } = deps;
  // Fetch a generous slice so excluding already-added topics still leaves room
  // for up to MAX_EMERGING_INTERESTS, then cap after filtering.
  const emerging = await listEmergingTopics(db, userId, 50);
  const added = new Set((await listUserTopics(db, userId)).map((t) => t.topicId));
  return emerging
    .filter((e) => !added.has(e.topicId))
    .slice(0, MAX_EMERGING_INTERESTS)
    .map((e) => ({ topicId: e.topicId }));
}

/**
 * Accept an emerging interest topic (Requirements 24.5, 24.6). When the topic is
 * a member of the user's emerging list it is added with `source = inferred`
 * (weight 1.0) and removed from the emerging list. When the topic is NOT in the
 * emerging list, a not-found error is returned and no state is changed.
 */
export async function acceptEmergingInterest(
  deps: EmergingInterestsDeps,
  userId: string,
  topicId: string,
): Promise<AcceptEmergingResult> {
  const { db } = deps;

  // (24.6) Only topics currently in the user's emerging list may be accepted.
  const emerging = await findEmergingTopic(db, userId, topicId);
  if (!emerging) {
    return {
      ok: false,
      error: makeError(ERROR_CODES.NOT_FOUND, 'No such emerging topic is available', {
        topicId,
      }),
    };
  }

  // (24.5) Add with source = inferred, then remove from the emerging list.
  await upsertUserTopic(db, userId, {
    topicId,
    weight: INFERRED_TOPIC_WEIGHT,
    source: 'inferred',
  });
  await deleteEmergingTopic(db, userId, topicId);

  return { ok: true, topicId };
}

/**
 * Build the feed-evolution narrative (Requirements 24.7, 24.10).
 *
 * When the user has no reading history (no `dwell` events ever recorded) the
 * narrative reports insufficient history (Requirement 24.10). Otherwise it
 * summarizes the shift in attention from the 7-day topic-trend breakdown,
 * bounded to 1-3 sentences.
 */
export async function getFeedEvolutionNarrative(
  deps: EmergingInterestsDeps,
  userId: string,
  nowMs: number,
): Promise<FeedEvolutionNarrative> {
  const { db } = deps;

  // (24.10) "No reading history" means no quality-reading (`dwell`) events ever.
  const dwellEvents = await listFeedEventsInWindow(db, userId, {
    from: EPOCH_ISO,
    to: new Date(nowMs).toISOString(),
    types: ['dwell'],
  });
  if (dwellEvents.length === 0) {
    return {
      hasHistory: false,
      narrative:
        'There is not yet enough reading history to describe how your interests are evolving. Read a few articles and your curiosity profile will start to take shape.',
    };
  }

  // (24.7) Summarize the shift from the 7-day trend breakdown, 1-3 sentences.
  const breakdown = await getTopicBreakdown({ db }, userId, nowMs);
  const growing = breakdown.filter((t) => t.trend === 'growing').length;
  const fading = breakdown.filter((t) => t.trend === 'fading').length;

  const sentences: string[] = [];
  if (growing > 0) {
    sentences.push(
      `Over the past week your curiosity has been expanding, with ${growing} ${growing === 1 ? 'topic' : 'topics'} growing in your attention.`,
    );
  }
  if (fading > 0) {
    sentences.push(
      `Meanwhile, interest in ${fading} ${fading === 1 ? 'topic' : 'topics'} has been fading.`,
    );
  }
  if (sentences.length === 0) {
    sentences.push('Your reading interests have held steady over the past week.');
  }

  return { hasHistory: true, narrative: sentences.join(' ') };
}

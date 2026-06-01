// Feed_Event_Service — mute_topic target resolution (Requirement 23.4).
//
// A `mute_topic` Feed_Event mutes a single topic, but the Mobile_App's action
// sheet operates on an *article*, not a topic (Requirement 23.4): when the user
// selects "mute topic", the Feed_Event_Service must record the event for the
// Topic with the highest association confidence for that article.
//
// This module isolates that resolution from the batch-ingestion flow in
// `ingest.ts`. It is a thin, injected wrapper over the article-topics
// repository's `findHighestConfidenceTopic` query (which already orders by
// descending confidence with a deterministic `topic_id` tie-break), so it is
// fully unit-testable with a FakeQueryable and never talks to `pg` directly.

import type { FeedEventInput } from '@lumina/shared';
import { type Queryable } from '../repositories/queryable.js';
import { findHighestConfidenceTopic } from '../repositories/article-topics.repository.js';
import type { InsertFeedEventInput } from '../repositories/types.js';

/** Dependencies for mute_topic resolution; a live pool or an in-memory fake. */
export interface MuteTopicDeps {
  db: Queryable;
}

/**
 * Resolve the topic a `mute_topic` event should target for an article: the
 * topic with the highest association confidence for that article
 * (Requirement 23.4).
 *
 * Returns the resolved topic id, or `null` when the article has no topic
 * associations (there is nothing to mute). Ties are broken deterministically by
 * `topic_id` ascending — the ordering enforced by the repository query — so the
 * same article always resolves to the same topic.
 */
export async function resolveMuteTopicTarget(
  deps: MuteTopicDeps,
  articleId: string,
): Promise<string | null> {
  const topic = await findHighestConfidenceTopic(deps.db, articleId);
  return topic ? topic.topicId : null;
}

/**
 * Enrich a `mute_topic` Feed_Event with the topic it should target before
 * persistence (Requirement 23.4).
 *
 * Given a submitted `mute_topic` event referencing an article, resolves the
 * highest-confidence topic for that article and returns the corresponding
 * {@link InsertFeedEventInput} with its `topicId` populated. Returns `null` when
 * the event carries no `articleId` or the article has no topic associations, in
 * which case there is no topic to mute and the event should not be persisted.
 *
 * The returned shape mirrors the repository insert input the batch flow uses, so
 * a caller can persist it through the same feed-events repository.
 */
export async function resolveMuteTopicEvent(
  deps: MuteTopicDeps,
  event: FeedEventInput,
): Promise<InsertFeedEventInput | null> {
  if (event.articleId === null || event.articleId === undefined) {
    return null;
  }
  const topicId = await resolveMuteTopicTarget(deps, event.articleId);
  if (topicId === null) {
    return null;
  }
  return {
    clientEventId: event.clientEventId,
    articleId: event.articleId,
    topicId,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

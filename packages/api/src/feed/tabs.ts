// Feed_Service — active feed tabs.
//
// Implements the design's `getTabs` (Requirement 8.5): the active-tabs response
// begins with the personalized `foryou` tab, FIRST, followed by between 1 and
// 10 Topic tabs ordered by DESCENDING current topic weight, INCLUDING ONLY
// topics whose weight is strictly greater than 0 (weight-0 topics are
// excluded). The topic-tab list is capped at 10.
//
// The filtering (weight > 0), ordering (descending weight), and capping (<= 10)
// are performed in code rather than in SQL so the behaviour is fully
// unit-testable with an in-memory FakeQueryable (which returns canned rows
// without executing SQL clauses). DB access goes through the narrow
// {@link Queryable} interface and the existing repository functions, so this
// module never opens a network connection.
//
// A user's `user_topic` rows carry only the topic id and weight, so each tab's
// key (the topic slug) and label are resolved via the topics repository in a
// single batched lookup; the final ordering follows the weight order, never the
// order in which the topics repository returns its rows.

import type { FeedTab, FeedTabsResponse } from '@lumina/shared';
import {
  findTopicsByIds,
  listUserTopics,
  type Queryable,
  type UserTopicRecord,
} from '../repositories/index.js';
import { FORYOU_TAB } from './candidates.js';

/** Human-readable label for the reserved personalized `foryou` tab. */
export const FORYOU_TAB_LABEL = 'For You';

/**
 * Maximum number of Topic tabs returned after the `foryou` tab (Requirement
 * 8.5). The personalized tab is always returned in addition to these.
 */
export const MAX_TOPIC_TABS = 10;

/** Dependencies injected into {@link getTabs}. */
export interface FeedTabsDeps {
  /** The shared query surface (a live `pg` pool in production, a fake in tests). */
  db: Queryable;
}

/**
 * Order two user-topic associations by descending weight, breaking ties by
 * ascending topic id so the result is deterministic for equal weights (matching
 * the repository's `ORDER BY weight DESC, topic_id ASC`).
 */
function byDescendingWeight(a: UserTopicRecord, b: UserTopicRecord): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (a.topicId < b.topicId) return -1;
  if (a.topicId > b.topicId) return 1;
  return 0;
}

/**
 * Return the active feed tabs for a user (Requirement 8.5, design `getTabs`).
 *
 * The response is the `foryou` tab followed by the user's Topic tabs:
 * 1. Load the user's topic associations.
 * 2. Keep only topics whose weight is strictly greater than 0 (exclude weight-0
 *    topics).
 * 3. Order the survivors by descending weight (ties broken by topic id).
 * 4. Cap the list at {@link MAX_TOPIC_TABS} (10).
 * 5. Resolve each surviving topic's slug (the tab key) and label via the topics
 *    repository, preserving the weight order.
 *
 * The `foryou` tab is always first. A topic whose row cannot be resolved (e.g.
 * a deleted topic still referenced by `user_topic`) is skipped defensively.
 */
export async function getTabs(
  deps: FeedTabsDeps,
  userId: string,
): Promise<FeedTabsResponse> {
  const { db } = deps;

  // (1) Load the user's topic associations.
  const userTopics = await listUserTopics(db, userId);

  // (2) Keep only topics with weight strictly greater than 0 (Requirement 8.5).
  // (3) Order by descending weight (ties by topic id).
  // (4) Cap at 10 topic tabs.
  const ranked = userTopics
    .filter((topic) => topic.weight > 0)
    .sort(byDescendingWeight)
    .slice(0, MAX_TOPIC_TABS);

  // (5) Resolve slug/label for the surviving topics in one batched lookup, then
  //     build the tabs in the ranked order (not the lookup's row order).
  const topics = await findTopicsByIds(
    db,
    ranked.map((topic) => topic.topicId),
  );
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));

  const topicTabs: FeedTab[] = [];
  for (const userTopic of ranked) {
    const topic = topicById.get(userTopic.topicId);
    if (!topic) continue; // skip an unresolved (e.g. deleted) topic defensively
    topicTabs.push({ key: topic.slug, label: topic.label });
  }

  return {
    tabs: [{ key: FORYOU_TAB, label: FORYOU_TAB_LABEL }, ...topicTabs],
  };
}

// Feed_Event_Service — batched behaviour-event ingestion (Requirement 13).
//
// Implements the design's Feed_Event_Service `POST /events/batch` contract:
//
//   - Rejects the ENTIRE batch when it exceeds 500 events, persisting nothing
//     and returning a uniform validation error (Requirement 13.5).
//   - Validates each event's `type` against the allowed FeedEventType set and
//     its required fields, rejecting invalid events individually while
//     persisting the remaining valid ones (Requirements 13.1, 13.2).
//   - De-duplicates by client-supplied `clientEventId` — both repeats within
//     the batch and ids already persisted — without creating new rows
//     (Requirement 13.4).
//   - Returns `{ persisted, rejected, duplicates }` whose buckets partition the
//     submitted events exactly, so `persisted + rejected.length + duplicates`
//     equals the submitted count (Requirement 13.3).
//
// All persistence flows through the feed-events repository over the narrow
// {@link Queryable} interface, so the service is fully unit-testable with an
// in-memory FakeQueryable and never talks to `pg` directly. Idempotency is
// enforced at two layers: the service collapses within-batch repeats and skips
// ids the DB already holds, and the repository's `INSERT … ON CONFLICT
// (user_id, client_event_id) DO NOTHING` is the authoritative guard against
// races, so anything the DB declines to insert is still accounted as a
// duplicate.

import {
  FEED_EVENT_TYPES,
  type FeedEventBatchRequest,
  type FeedEventBatchResponse,
  type FeedEventInput,
  type RejectedEvent,
  ERROR_CODES,
  makeError,
  type ApiErrorEnvelope,
} from '@lumina/shared';
import { type Queryable } from '../repositories/queryable.js';
import {
  findExistingClientEventIds,
  insertFeedEvents,
} from '../repositories/feed-events.repository.js';
import type { InsertFeedEventInput } from '../repositories/types.js';

/**
 * The maximum number of events accepted in a single batch (Requirement 13.5).
 * A batch with strictly more than this many events is rejected atomically.
 */
export const MAX_BATCH_SIZE = 500;

/** The allowed Feed_Event types as a lookup set (Requirement 13.2). */
const ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set(FEED_EVENT_TYPES);

/** Dependencies for {@link ingestBatch}; a live pool or an in-memory fake. */
export interface IngestBatchDeps {
  db: Queryable;
}

/**
 * The outcome of an ingestion attempt. The over-limit case is a uniform
 * validation error rather than a partial acknowledgement, because no events are
 * processed (Requirement 13.5); every other case is an acknowledgement whose
 * counts reconcile to the submitted batch size (Requirement 13.3).
 */
export type IngestBatchResult =
  /** The batch was processed; `ack` partitions the submitted events. */
  | { status: 'ok'; ack: FeedEventBatchResponse }
  /** The whole batch was rejected (over the size limit); nothing persisted. */
  | { status: 'error'; error: ApiErrorEnvelope };

/**
 * Validate a single submitted event's required fields (Requirement 13.1) and
 * its `type` against the allowed set (Requirement 13.2). Returns a
 * human-readable rejection reason, or `null` when the event is well-formed.
 *
 * Events arrive from an untrusted client, so each field is checked defensively
 * even though the static type narrows them: a non-empty `clientEventId` (needed
 * for idempotency), a `type` within the allowed set, and a parseable
 * `occurredAt` timestamp. `articleId` is intentionally optional/nullable —
 * events such as `session_end` carry no article reference.
 */
function validateEvent(event: FeedEventInput): string | null {
  if (typeof event.clientEventId !== 'string' || event.clientEventId.trim() === '') {
    return 'Missing or invalid clientEventId.';
  }
  if (typeof event.type !== 'string' || !ALLOWED_EVENT_TYPES.has(event.type)) {
    return `Unsupported event type: ${JSON.stringify(event.type)}.`;
  }
  if (
    typeof event.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    return 'Missing or invalid occurredAt timestamp.';
  }
  return null;
}

/** Map a validated submitted event to the repository's insert shape. */
function toInsertInput(event: FeedEventInput): InsertFeedEventInput {
  return {
    clientEventId: event.clientEventId,
    articleId: event.articleId ?? null,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

/**
 * Ingest a batch of behaviour events for one user (Requirement 13).
 *
 * Processing assigns every submitted event to exactly one of three buckets so
 * the acknowledgement reconciles exactly to the submitted count
 * (`persisted + rejected.length + duplicates === events.length`,
 * Requirement 13.3):
 *
 *  1. **Over-limit guard (Requirement 13.5).** If the batch exceeds
 *     {@link MAX_BATCH_SIZE}, reject the entire batch atomically — persist
 *     nothing and return a uniform `VALIDATION_ERROR`.
 *  2. **Validation (Requirements 13.1, 13.2).** Each event with an unknown
 *     `type` or a missing/invalid required field is collected into `rejected`
 *     with a reason; valid events proceed.
 *  3. **De-duplication (Requirement 13.4).** Among valid events, a
 *     `clientEventId` repeated within the batch keeps only its first occurrence;
 *     ids already persisted for the user are skipped. Both are counted as
 *     `duplicates` and never create new rows. The repository's
 *     `ON CONFLICT DO NOTHING` is the final authority, so any candidate the DB
 *     declines to insert (e.g. a concurrent writer) is also counted as a
 *     duplicate rather than lost from the accounting.
 */
export async function ingestBatch(
  deps: IngestBatchDeps,
  userId: string,
  request: FeedEventBatchRequest,
): Promise<IngestBatchResult> {
  const events = request.events;

  // (13.5) Atomic over-limit rejection: process nothing.
  if (events.length > MAX_BATCH_SIZE) {
    return {
      status: 'error',
      error: makeError(
        ERROR_CODES.VALIDATION_ERROR,
        `Batch size ${events.length} exceeds the maximum of ${MAX_BATCH_SIZE} events.`,
        { maxBatchSize: MAX_BATCH_SIZE, received: events.length },
      ),
    };
  }

  const rejected: RejectedEvent[] = [];
  const seenInBatch = new Set<string>();
  const candidates: InsertFeedEventInput[] = [];
  let duplicates = 0;

  // (13.1, 13.2) Validate, then (13.4) collapse within-batch repeats.
  for (const event of events) {
    const reason = validateEvent(event);
    if (reason !== null) {
      rejected.push({ clientEventId: event.clientEventId, reason });
      continue;
    }
    if (seenInBatch.has(event.clientEventId)) {
      duplicates += 1;
      continue;
    }
    seenInBatch.add(event.clientEventId);
    candidates.push(toInsertInput(event));
  }

  // (13.4) Skip ids already persisted for this user.
  const existing = await findExistingClientEventIds(
    deps.db,
    userId,
    candidates.map((c) => c.clientEventId),
  );
  const existingIds = new Set(existing);
  const toInsert = candidates.filter((c) => !existingIds.has(c.clientEventId));
  duplicates += candidates.length - toInsert.length;

  // (13.1) Persist the valid, distinct, not-yet-stored events. The repository
  // returns only newly-inserted rows; anything ON CONFLICT skipped is a
  // duplicate, keeping the accounting exact (13.3).
  const inserted = await insertFeedEvents(deps.db, userId, toInsert);
  const persisted = inserted.length;
  duplicates += toInsert.length - persisted;

  return { status: 'ok', ack: { persisted, rejected, duplicates } };
}

// Signal_Collector capture logic for the Mobile_App (Requirement 12.1–12.7).
//
// Mirrors the "Signal_Collector (Mobile_App)" section of the design document.
// The behaviours described there (onCardVisible, onCardHidden, onExpand,
// onScrollDepth, onLinkOut) are implemented here as PURE state-transition /
// classification functions: each takes the current CaptureState plus an input
// (and a caller-supplied timestamp) and returns the produced Feed_Event(s)
// together with the next CaptureState. There are no timers, no I/O and no
// React, so the visibility/dwell/skip/scroll classification can be exhaustively
// unit- and property-tested without a device or a UI.
//
// Covered acceptance criteria:
//   - 12.1 impression on ≥50% visibility.
//   - 12.2 track elapsed dwell duration while ≥50% visible (the visibility
//     start time is recorded so the duration can be computed on hide).
//   - 12.3 expand event on tap-to-expand.
//   - 12.4 skip event when the card exits within 1500 ms of becoming visible.
//   - 12.5 exactly one dwell event capturing the duration in ms when the card
//     exits after remaining visible for ≥1500 ms.
//   - 12.6 scroll_depth event capturing the new maximum scrolled proportion,
//     fired only when that maximum rises by ≥0.25.
//   - 12.7 link_out event when an external link is opened.
//
// The produced events carry a client-generated `clientEventId` (UUID by
// default, or an injected generator) and an ISO-8601 `occurredAt`, so each one
// is directly enqueueable into the durable buffer (task 25.1): a
// {@link CapturedFeedEvent} is structurally assignable to `NewBufferedEvent`.

import type { FeedEventType } from '@lumina/shared';

/** Minimum viewport coverage that counts as "visible" (Requirement 12.1). */
export const VISIBILITY_THRESHOLD = 0.5;

/**
 * Dwell boundary in milliseconds. Exiting in strictly less than this is a skip
 * (Requirement 12.4); remaining visible for this long or longer is a dwell
 * (Requirement 12.5). The boundary value itself (1500 ms) classifies as dwell.
 */
export const DWELL_THRESHOLD_MS = 1500;

/**
 * Minimum rise in the maximum scrolled proportion that triggers a scroll_depth
 * event (Requirement 12.6). A rise of exactly this much emits.
 */
export const SCROLL_DEPTH_STEP = 0.25;

/** A function that mints a fresh, unique `clientEventId` for each event. */
export type IdGenerator = () => string;

/**
 * A Feed_Event produced by the capture logic. Carries the core Feed_Event shape
 * `{ type, articleId, payload, occurredAt }` plus a client-generated
 * `clientEventId` for server-side idempotency (Requirement 13.4). The shape is
 * structurally assignable to the durable buffer's `NewBufferedEvent`, so a
 * captured event can be enqueued without translation.
 */
export interface CapturedFeedEvent {
  /** Client-generated identifier; idempotency key for the Feed_Event_Service. */
  readonly clientEventId: string;
  /** One of the allowed Feed_Event types (Requirement 12). */
  readonly type: FeedEventType;
  /** Target article (always set for the events captured here). */
  readonly articleId: string;
  /** Event-specific payload, e.g. `{ dwellMs }` or `{ scrollProportion }`. */
  readonly payload: Record<string, unknown>;
  /** Caller-supplied occurrence time as an ISO-8601 (UTC) string. */
  readonly occurredAt: string;
}

/**
 * Per-article capture state. Tracks the in-progress dwell timer and the maximum
 * scrolled proportion that has already been recorded by a scroll_depth event.
 */
export interface ArticleSignalState {
  /**
   * Epoch milliseconds at which the card became ≥50% visible, or null when the
   * card is not currently visible. Recording this is how the elapsed dwell
   * duration is tracked (Requirement 12.2).
   */
  readonly visibleSinceMs: number | null;
  /**
   * The maximum scrolled proportion (in [0,1]) captured by the most recent
   * emitted scroll_depth event. A new scroll_depth event fires only when an
   * incoming proportion exceeds this recorded maximum by ≥{@link SCROLL_DEPTH_STEP}
   * (Requirement 12.6); on emit, this advances to the new maximum.
   */
  readonly maxScrollProportion: number;
}

/**
 * The complete Signal_Collector capture state: per-article dwell/scroll
 * tracking keyed by article id. All fields are readonly; transitions return a
 * new object rather than mutating in place, keeping every function pure.
 */
export interface CaptureState {
  readonly articles: Readonly<Record<string, ArticleSignalState>>;
}

/**
 * The result of a capture transition: the events to enqueue (zero or one for
 * the visibility/scroll handlers) and the next capture state.
 */
export interface CaptureResult {
  readonly state: CaptureState;
  readonly events: readonly CapturedFeedEvent[];
}

/** An empty capture state with no articles tracked. */
export const EMPTY_CAPTURE_STATE: CaptureState = { articles: {} };

/** Construct a fresh, empty capture state. */
export function initialCaptureState(): CaptureState {
  return EMPTY_CAPTURE_STATE;
}

const DEFAULT_ARTICLE_STATE: ArticleSignalState = {
  visibleSinceMs: null,
  maxScrollProportion: 0,
};

/** Default id generator: a v4 UUID from the platform Web Crypto API. */
const defaultIdGenerator: IdGenerator = () => globalThis.crypto.randomUUID();

/** Clamp a proportion onto the [0,1] scale (Requirement 12.6). */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Predicate for Requirement 12.1's "at least 50% visible" threshold. */
export function meetsVisibilityThreshold(visibleProportion: number): boolean {
  return visibleProportion >= VISIBILITY_THRESHOLD;
}

/** Read the per-article state, falling back to the empty default. */
function getArticleState(state: CaptureState, articleId: string): ArticleSignalState {
  return state.articles[articleId] ?? DEFAULT_ARTICLE_STATE;
}

/** Return a new CaptureState with one article's state replaced. */
function withArticleState(
  state: CaptureState,
  articleId: string,
  next: ArticleSignalState,
): CaptureState {
  return { articles: { ...state.articles, [articleId]: next } };
}

/** Build a buffer-ready Feed_Event from the captured signal. */
function makeEvent(
  type: FeedEventType,
  articleId: string,
  occurredAtMs: number,
  generateId: IdGenerator,
  payload: Record<string, unknown> = {},
): CapturedFeedEvent {
  return {
    clientEventId: generateId(),
    type,
    articleId,
    payload,
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
}

/**
 * A card became ≥50% visible (Requirement 12.1, 12.2). Records an `impression`
 * Feed_Event and starts the dwell timer by storing the visibility start time.
 *
 * Idempotent while continuously visible: if the card is already marked visible,
 * this is a no-op (no duplicate impression, the original start time is kept), so
 * repeated viewability callbacks do not double-count.
 */
export function onCardVisible(
  state: CaptureState,
  articleId: string,
  nowMs: number,
  generateId: IdGenerator = defaultIdGenerator,
): CaptureResult {
  const current = getArticleState(state, articleId);
  if (current.visibleSinceMs !== null) {
    return { state, events: [] };
  }
  const impression = makeEvent('impression', articleId, nowMs, generateId);
  const next = withArticleState(state, articleId, {
    ...current,
    visibleSinceMs: nowMs,
  });
  return { state: next, events: [impression] };
}

/**
 * A card exited the viewport (Requirements 12.4, 12.5). Computes the elapsed
 * visible duration and classifies it into exactly one event:
 *   - elapsed < 1500 ms → one `skip` event,
 *   - elapsed ≥ 1500 ms → one `dwell` event capturing the duration in ms.
 * The dwell timer is cleared. If the card was not currently visible this is a
 * no-op (no event). Negative elapsed (clock skew) is clamped to 0.
 */
export function onCardHidden(
  state: CaptureState,
  articleId: string,
  nowMs: number,
  generateId: IdGenerator = defaultIdGenerator,
): CaptureResult {
  const current = getArticleState(state, articleId);
  if (current.visibleSinceMs === null) {
    return { state, events: [] };
  }
  const dwellMs = Math.max(0, nowMs - current.visibleSinceMs);
  const type: FeedEventType = dwellMs >= DWELL_THRESHOLD_MS ? 'dwell' : 'skip';
  const event = makeEvent(type, articleId, nowMs, generateId, { dwellMs });
  const next = withArticleState(state, articleId, {
    ...current,
    visibleSinceMs: null,
  });
  return { state: next, events: [event] };
}

/**
 * The user tapped to expand a card (Requirement 12.3). Produces a single
 * `expand` Feed_Event. Carries no capture state.
 */
export function onExpand(
  articleId: string,
  nowMs: number,
  generateId: IdGenerator = defaultIdGenerator,
): CapturedFeedEvent {
  return makeEvent('expand', articleId, nowMs, generateId);
}

/**
 * The user opened an external link from an article (Requirement 12.7). Produces
 * a single `link_out` Feed_Event. Carries no capture state.
 */
export function onLinkOut(
  articleId: string,
  nowMs: number,
  generateId: IdGenerator = defaultIdGenerator,
): CapturedFeedEvent {
  return makeEvent('link_out', articleId, nowMs, generateId);
}

/**
 * A new scrolled proportion was observed in the Reader (Requirement 12.6).
 * `proportion` is the current scroll position on a 0.0–1.0 scale (clamped). A
 * `scroll_depth` event capturing the new maximum is emitted only when the
 * incoming proportion exceeds the last recorded maximum by ≥0.25; otherwise no
 * event is produced and the state is unchanged. A rise of exactly 0.25 emits.
 */
export function onScrollDepth(
  state: CaptureState,
  articleId: string,
  proportion: number,
  nowMs: number,
  generateId: IdGenerator = defaultIdGenerator,
): CaptureResult {
  const current = getArticleState(state, articleId);
  const scrollProportion = clamp01(proportion);
  if (scrollProportion - current.maxScrollProportion >= SCROLL_DEPTH_STEP) {
    const event = makeEvent('scroll_depth', articleId, nowMs, generateId, {
      scrollProportion,
    });
    const next = withArticleState(state, articleId, {
      ...current,
      maxScrollProportion: scrollProportion,
    });
    return { state: next, events: [event] };
  }
  return { state, events: [] };
}

// Preference_Model_Updater — event-type signal weighting.
// (Requirement 14.3; Property 29.)
//
// The Preference_Model_Updater converts a user's recorded Feed_Events into a
// single scalar "interest signal" by summing a fixed per-event-type weight.
// Every event type contributes a constant weight except `scroll_depth`, whose
// contribution scales with how far the reader scrolled: it is the base weight
// (0.10) multiplied by the recorded scroll proportion, clamped to [0.0, 1.0].
//
// These functions are pure, deterministic, and total: any event — including
// one with an unknown type, a missing payload, or a malformed/out-of-range
// `scrollProportion` — maps to a well-defined finite number (a missing or
// invalid scroll proportion is treated as 0).

import { FEED_EVENT_TYPES, type FeedEventType } from '@lumina/shared';

/**
 * Base interest-signal weight for each {@link FeedEventType}.
 *
 * For every type other than `scroll_depth` this is the exact signal an event
 * of that type contributes. For `scroll_depth` this is the *coefficient* that
 * is multiplied by the clamped scroll proportion (see {@link eventSignal}),
 * so a full-page scroll (proportion 1.0) contributes the listed 0.10 while a
 * partial scroll contributes proportionally less.
 *
 * (Requirement 14.3.)
 */
export const EVENT_TYPE_WEIGHTS: Readonly<Record<FeedEventType, number>> = {
  impression: 0.05,
  dwell: 0.15,
  expand: 0.35,
  scroll_depth: 0.1,
  save: 0.5,
  unsave: 0.0,
  share: 0.6,
  link_out: 0.45,
  skip: -0.2,
  session_end: 0.0,
  mute_topic: -1.0,
};

/**
 * Minimal shape of an event consumed by the signal weighting. Mirrors the
 * relevant fields of `FeedEventInput`/the stored Feed_Event: a `type` and an
 * optional `payload`. The `scroll_depth` payload is expected to carry a
 * numeric `scrollProportion` in [0.0, 1.0].
 */
export interface SignalEvent {
  type: FeedEventType;
  payload?: Record<string, unknown> | null;
}

/** Clamps `value` into the inclusive range [`min`, `max`]; maps NaN to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Reads `scrollProportion` from an event payload and clamps it to [0.0, 1.0].
 * A missing payload, a missing field, or a non-finite value (NaN, ±Infinity,
 * non-number) is treated as a scroll proportion of 0.
 */
export function readScrollProportion(payload: SignalEvent['payload']): number {
  const raw = payload?.scrollProportion;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return clamp(raw, 0, 1);
}

/**
 * Computes the interest signal contributed by a single Feed_Event
 * (Requirement 14.3, Property 29).
 *
 * - `scroll_depth`: `0.10 × clamp(scrollProportion, 0, 1)`, reading
 *   `scrollProportion` from the payload (treated as 0 when missing/invalid).
 * - every other known type: its fixed {@link EVENT_TYPE_WEIGHTS} weight.
 * - an unknown type: `0` (the function is total over arbitrary input).
 *
 * Deterministic: the same event always yields the same number.
 */
export function eventSignal(event: SignalEvent): number {
  const weight = EVENT_TYPE_WEIGHTS[event.type];
  if (weight === undefined) return 0;
  if (event.type === 'scroll_depth') {
    return weight * readScrollProportion(event.payload);
  }
  return weight;
}

/**
 * Sums the interest signals of a collection of events (Requirement 14.3).
 * Returns 0 for an empty collection. This is the per-event {@link eventSignal}
 * folded with addition, used to aggregate a user's net signal over a window
 * (or, when grouped upstream, the net signal per article).
 */
export function aggregateSignal(events: readonly SignalEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += eventSignal(event);
  }
  return total;
}

/**
 * Groups events by a caller-supplied key (e.g. `articleId`) and sums each
 * group's interest signal via {@link aggregateSignal}. Convenience helper for
 * the per-article net-signal step of the Preference_Model_Updater; events for
 * which `keyOf` returns `null`/`undefined` are skipped.
 */
export function aggregateSignalByKey<T extends SignalEvent>(
  events: readonly T[],
  keyOf: (event: T) => string | null | undefined,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of events) {
    const key = keyOf(event);
    if (key === null || key === undefined) continue;
    totals.set(key, (totals.get(key) ?? 0) + eventSignal(event));
  }
  return totals;
}

/** The set of every event type that carries a non-special fixed weight. */
export const FIXED_WEIGHT_EVENT_TYPES: readonly FeedEventType[] = FEED_EVENT_TYPES.filter(
  (type) => type !== 'scroll_depth',
);

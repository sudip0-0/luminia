// Feature: lumina, Property 29: Event-type signal weighting is deterministic and correctly scaled
//
// Property-based coverage for the Preference_Model_Updater's event-type signal
// weighting (Requirement 14.3).
//
// Property 29 (design.md): *For any* set of Feed_Events, the computed interest
// signal equals the sum of per-event weights using impression 0.05, dwell 0.15,
// expand 0.35, scroll_depth 0.10 × scrollProportion, save 0.50, unsave 0.0,
// share 0.60, link_out 0.45, skip −0.20, session_end 0.0, and mute_topic −1.00,
// with scrollProportion clamped to [0.0, 1.0].
//
// This file exercises four complementary sub-properties, each over a minimum of
// 100 generated iterations:
//
//   (1) Fixed weights: for any FeedEventType other than `scroll_depth`,
//       `eventSignal` returns exactly the EVENT_TYPE_WEIGHTS value for that
//       type, regardless of the (arbitrary) payload attached.
//   (2) scroll_depth scaling: for `scroll_depth` with any payload,
//       `eventSignal === 0.10 × clamp(scrollProportion, 0, 1)`, and is exactly
//       0 when the proportion is missing, non-finite, or out-of-range-low
//       (≤ 0). Generated proportions span negative, [0,1], > 1, NaN/Infinity,
//       and missing.
//   (3) Determinism: the same event always yields the same number.
//   (4) Aggregation: `aggregateSignal` over a generated list equals the sum of
//       `eventSignal` over that same list.
//
// Implementation files are not modified; this test only observes the public
// signal-weights API.
//
// Validates: Requirements 14.3

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { FeedEventType } from '@lumina/shared';
import {
  EVENT_TYPE_WEIGHTS,
  FIXED_WEIGHT_EVENT_TYPES,
  eventSignal,
  aggregateSignal,
  type SignalEvent,
} from './signal-weights.js';

const RUNS = { numRuns: 200 } as const;

// Normalizes a signed zero (-0) to +0 so numeric comparisons reflect the
// mathematical value: the signal "=== 0" property concerns numeric equality,
// where -0 and +0 are equal, even though Jest/Vitest `.toBe` uses Object.is and
// distinguishes them. `0.10 × clamp(-0, 0, 1)` legitimately yields -0.
const norm = (x: number): number => (x === 0 ? 0 : x);

// A scroll proportion arbitrary that deliberately spans the full input space:
// the valid [0,1] range, negative values, values > 1, extreme finite
// magnitudes, and the non-finite values (NaN, ±Infinity) the weighting must
// tolerate (each treated as 0).
const messyProportion: fc.Arbitrary<number> = fc.oneof(
  // In-range, the common case.
  fc.double({ min: 0, max: 1, noNaN: true }),
  // Spans negatives and > 1.
  fc.double({ min: -1000, max: 1000, noNaN: true }),
  // Extreme finite magnitudes.
  fc.double({ noNaN: true }),
  // Explicit edge / out-of-range / non-finite constants.
  fc.constantFrom(
    0,
    -0,
    1,
    -1,
    0.25,
    0.5,
    0.9999999,
    1.0000001,
    1.5,
    42,
    -0.3,
    -100,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ),
);

// Payloads for a scroll_depth event: a numeric scrollProportion (sometimes with
// unrelated extra fields), as well as the "missing" shapes — empty payload, an
// unrelated payload, a null payload, and a wholly absent payload.
const scrollPayloadArb: fc.Arbitrary<SignalEvent['payload']> = fc.oneof(
  messyProportion.map((scrollProportion) => ({ scrollProportion })),
  messyProportion.map((scrollProportion) => ({ scrollProportion, extra: 'x', n: 1 })),
  fc.constant({}),
  fc.constant(undefined),
  fc.constant(null),
  fc.record({ foo: fc.integer() }),
);

const scrollEventArb: fc.Arbitrary<SignalEvent> = scrollPayloadArb.map((payload) => ({
  type: 'scroll_depth' as FeedEventType,
  payload,
}));

// Arbitrary payloads attached to fixed-weight events — including ones carrying a
// scrollProportion — to confirm the payload is ignored for non-scroll types.
const arbitraryPayloadArb: fc.Arbitrary<SignalEvent['payload']> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant({}),
  messyProportion.map((scrollProportion) => ({ scrollProportion })),
  fc.record({ dwellMs: fc.integer(), foo: fc.string() }),
);

const fixedEventArb: fc.Arbitrary<SignalEvent> = fc.record({
  type: fc.constantFrom(...FIXED_WEIGHT_EVENT_TYPES),
  payload: arbitraryPayloadArb,
});

const anyEventArb: fc.Arbitrary<SignalEvent> = fc.oneof(fixedEventArb, scrollEventArb);

// Reference implementation of the scroll_depth signal, derived directly from the
// Requirement 14.3 formula: 0.10 × clamp(scrollProportion, 0, 1), with a
// missing/non-finite proportion treated as 0. Uses the published 0.10
// coefficient so the comparison is an exact floating-point match.
function expectedScrollSignal(payload: SignalEvent['payload']): number {
  const raw = payload?.scrollProportion;
  const proportion =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return EVENT_TYPE_WEIGHTS.scroll_depth * proportion;
}

describe('Property 29 - event-type signal weighting (Req 14.3)', () => {
  it('(1) eventSignal equals the fixed EVENT_TYPE_WEIGHTS value for non-scroll_depth types, regardless of payload', () => {
    fc.assert(
      fc.property(fixedEventArb, (event) => {
        expect(eventSignal(event)).toBe(EVENT_TYPE_WEIGHTS[event.type]);
      }),
      RUNS,
    );
  });

  it('(2) eventSignal for scroll_depth equals 0.10 × clamp(scrollProportion, 0, 1) for any payload', () => {
    fc.assert(
      fc.property(scrollPayloadArb, (payload) => {
        const expected = expectedScrollSignal(payload);
        expect(norm(eventSignal({ type: 'scroll_depth', payload }))).toBe(norm(expected));
      }),
      RUNS,
    );
  });

  it('(2b) scroll_depth signal is exactly 0 when the proportion is missing, non-finite, or ≤ 0', () => {
    const zeroProportionArb = fc.oneof(
      fc.constant<SignalEvent['payload']>(undefined),
      fc.constant<SignalEvent['payload']>(null),
      fc.constant<SignalEvent['payload']>({}),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY).map(
        (scrollProportion) => ({ scrollProportion }),
      ),
      fc.double({ min: -1000, max: 0, noNaN: true }).map((scrollProportion) => ({
        scrollProportion,
      })),
    );
    fc.assert(
      fc.property(zeroProportionArb, (payload) => {
        expect(norm(eventSignal({ type: 'scroll_depth', payload }))).toBe(0);
      }),
      RUNS,
    );
  });

  it('(3) eventSignal is deterministic: the same event yields the same value', () => {
    fc.assert(
      fc.property(anyEventArb, (event) => {
        expect(eventSignal(event)).toBe(eventSignal(event));
      }),
      RUNS,
    );
  });

  it('(4) aggregateSignal equals the sum of eventSignal over the list', () => {
    fc.assert(
      fc.property(fc.array(anyEventArb, { maxLength: 50 }), (events) => {
        const expected = events.reduce((acc, event) => acc + eventSignal(event), 0);
        expect(norm(aggregateSignal(events))).toBe(norm(expected));
      }),
      RUNS,
    );
  });
});

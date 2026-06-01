// Feature: lumina, Property 30: The User_Embedding is the recency-weighted centroid of engaged articles, and recency strictly breaks ties
//
// Property-based coverage for the Preference_Model_Updater's recency-weighted
// centroid update (Requirements 14.4, 14.5; design Property 30).
//
// Property 30 (design.md): *For any* 30-day event history, the recomputed
// embedding is the recency-weighted centroid over exactly the engaged articles
// (those with net weighted signal > 0); and for any two engaged articles with
// equal net weighted signal, the one whose most recent Feed_Event occurred
// later contributes a strictly greater weight to the centroid.
//
// This file exercises two complementary sub-properties, each over a minimum of
// 100 generated iterations:
//
//   (1) Weighted-centroid correctness (Requirement 14.4): for generated
//       engaged-article event sets with known constant embeddings, the returned
//       centroid equals the independently computed weighted average
//       `sum(w_i * e_i) / sum(w_i)` (per-dimension, within epsilon), where
//       `w_i = netSignal_i * recencyWeight(mostRecent_i, nowMs)` over exactly
//       the articles with net signal > 0 and a usable embedding. Disengaged
//       articles (net signal <= 0), articles without an embedding, and events
//       with no article target are excluded from the reference exactly as the
//       implementation excludes them.
//
//   (2) Recency tie-break (Requirement 14.5): with two engaged articles of
//       EQUAL net signal but different most-recent event times, the centroid
//       lies strictly closer to the article whose most recent Feed_Event
//       occurred later (a strictly greater weight biases every dimension toward
//       that article's value).
//
// The implementation requires usable EMBEDDING_DIMENSIONS-wide vectors, so this
// test builds constant 1536-dim embeddings (every dimension equal to a single
// fill value) per article. Implementation files are not modified; this test
// only observes the public preference-model API.
//
// Validates: Requirements 14.4, 14.5

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { EMBEDDING_DIMENSIONS, type FeedEventType } from '@lumina/shared';
import {
  computeUserEmbedding,
  recencyWeight,
  eventsInWindow,
  THIRTY_DAYS_MS,
  type TimedSignalEvent,
} from './centroid.js';
import { eventSignal } from './signal-weights.js';

const RUNS = { numRuns: 120 } as const;

/** Builds a constant {@link EMBEDDING_DIMENSIONS}-wide vector (every dim === `fill`). */
function makeVector(fill: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(fill);
}

// --- Shared arbitraries -----------------------------------------------------

// `nowMs` (the run start / window end) kept comfortably above the window width
// so every generated event age in [0, 30d] lands inside the trailing window.
const nowMsArb = fc.integer({ min: THIRTY_DAYS_MS + 1000, max: 4_000_000_000_000 });

// Event age in milliseconds before `nowMs`; the resulting occurredAtMs is always
// within the inclusive 30-day window and never in the future.
const ageArb = fc.integer({ min: 0, max: THIRTY_DAYS_MS });

const fillArb = fc.double({ min: -10, max: 10, noNaN: true });

// Every feed event type, biased toward positive-signal types so generated
// articles are "engaged" (net signal > 0) often enough to exercise the centroid
// branch, while still emitting negatives (skip, mute_topic) and zero-weight
// types (unsave, session_end) for variety.
const ALL_TYPES: readonly FeedEventType[] = [
  'impression',
  'dwell',
  'expand',
  'scroll_depth',
  'save',
  'share',
  'link_out',
  'save',
  'expand',
  'share',
  'unsave',
  'skip',
  'session_end',
  'mute_topic',
];

interface EventSpec {
  type: FeedEventType;
  scrollProportion: number;
  age: number;
}

const eventSpecArb: fc.Arbitrary<EventSpec> = fc.record({
  type: fc.constantFrom(...ALL_TYPES),
  scrollProportion: fc.double({ min: 0, max: 1, noNaN: true }),
  age: ageArb,
});

// Non-negative-signal event specs only (no skip / mute_topic). Used for the
// forced engaged article's extra events so its net signal can never drop to or
// below 0 — keeping the "updated" centroid branch guaranteed in property (1).
const nonNegativeSpecArb: fc.Arbitrary<EventSpec> = fc.record({
  type: fc.constantFrom<FeedEventType>(
    'impression',
    'dwell',
    'expand',
    'scroll_depth',
    'save',
    'share',
    'link_out',
    'unsave',
    'session_end',
  ),
  scrollProportion: fc.double({ min: 0, max: 1, noNaN: true }),
  age: ageArb,
});

/** Turns an {@link EventSpec} into a TimedSignalEvent for `articleId` at `nowMs - age`. */
function toTimed(spec: EventSpec, articleId: string, nowMs: number): TimedSignalEvent {
  const occurredAtMs = nowMs - spec.age;
  if (spec.type === 'scroll_depth') {
    return { type: spec.type, articleId, occurredAtMs, payload: { scrollProportion: spec.scrollProportion } };
  }
  return { type: spec.type, articleId, occurredAtMs };
}

// --- Reference implementation (independent of computeUserEmbedding) ---------

/**
 * Independently computes the expected centroid value as the recency-weighted
 * average of the engaged articles' (constant) embeddings, using the documented
 * primitives `eventsInWindow`, `eventSignal`, and `recencyWeight`. Because each
 * article's embedding is constant across dimensions, the per-dimension centroid
 * is a single scalar; returns `null` when no engaged article with a usable
 * embedding contributes a positive weight (the "unchanged" case).
 */
function expectedCentroidValue(
  events: readonly TimedSignalEvent[],
  embeddings: ReadonlyMap<string, number>,
  nowMs: number,
): number | null {
  const windowed = eventsInWindow(events, nowMs);
  const byArticle = new Map<string, { net: number; recent: number }>();
  for (const event of windowed) {
    const id = event.articleId;
    if (id === null || id === undefined) continue;
    const signal = eventSignal(event);
    const cur = byArticle.get(id);
    if (cur === undefined) {
      byArticle.set(id, { net: signal, recent: event.occurredAtMs });
    } else {
      cur.net += signal;
      if (event.occurredAtMs > cur.recent) cur.recent = event.occurredAtMs;
    }
  }

  let totalWeight = 0;
  let weightedSum = 0;
  for (const [id, agg] of byArticle) {
    if (agg.net <= 0) continue; // not engaged (Requirement 14.4)
    const fill = embeddings.get(id);
    if (fill === undefined) continue; // no usable embedding to contribute
    const weight = agg.net * recencyWeight(agg.recent, nowMs);
    if (!(weight > 0)) continue;
    totalWeight += weight;
    weightedSum += weight * fill;
  }

  if (totalWeight <= 0) return null;
  return weightedSum / totalWeight;
}

// --- Property (1): weighted-centroid correctness ----------------------------

interface NoiseArticle {
  hasEmbedding: boolean;
  fill: number;
  events: EventSpec[];
}

const scenarioArb = fc.record({
  nowMs: nowMsArb,
  // A guaranteed-engaged article with a usable embedding: a `save` (0.50) plus
  // optional extra events keeps its net signal strictly positive, so the
  // "updated" branch is always exercised and the centroid math always tested.
  forcedFill: fillArb,
  forcedSaveAge: ageArb,
  forcedExtra: fc.array(nonNegativeSpecArb, { minLength: 0, maxLength: 4 }),
  // Additional articles that may be engaged or disengaged, with or without a
  // usable embedding — the centroid must include/exclude them correctly.
  noise: fc.array(
    fc.record({
      hasEmbedding: fc.boolean(),
      fill: fillArb,
      events: fc.array(eventSpecArb, { minLength: 0, maxLength: 6 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  // Occasionally include an article-less event (e.g. session_end) to confirm it
  // is ignored by the per-article grouping.
  includeNullEvent: fc.boolean(),
});

describe('Property 30 - recency-weighted centroid (Req 14.4, 14.5)', () => {
  it('(1) the centroid equals the recency-weighted average sum(w_i*e_i)/sum(w_i) over engaged articles with usable embeddings', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { nowMs, forcedFill, forcedSaveAge, forcedExtra, noise } = scenario;
        const events: TimedSignalEvent[] = [];
        const embeddings = new Map<string, number[]>();
        const fillByArticle = new Map<string, number>();

        // Forced engaged article (id 'forced').
        const forcedId = 'forced';
        events.push({ type: 'save', articleId: forcedId, occurredAtMs: nowMs - forcedSaveAge });
        for (const ev of forcedExtra) events.push(toTimed(ev, forcedId, nowMs));
        embeddings.set(forcedId, makeVector(forcedFill));
        fillByArticle.set(forcedId, forcedFill);

        // Noise articles.
        noise.forEach((art: NoiseArticle, i: number) => {
          const id = `a${i}`;
          for (const ev of art.events) events.push(toTimed(ev, id, nowMs));
          if (art.hasEmbedding) {
            embeddings.set(id, makeVector(art.fill));
            fillByArticle.set(id, art.fill);
          }
        });

        if (scenario.includeNullEvent) {
          events.push({ type: 'session_end', articleId: null, occurredAtMs: nowMs - 1000 });
        }

        const result = computeUserEmbedding(events, embeddings, nowMs);
        const expected = expectedCentroidValue(events, fillByArticle, nowMs);

        // The forced article guarantees at least one engaged + embedded article.
        expect(expected).not.toBeNull();
        expect(result.status).toBe('updated');
        if (result.status !== 'updated' || expected === null) return;

        expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
        const tol = 1e-6 * (1 + Math.abs(expected));
        for (const value of result.embedding) {
          expect(Math.abs(value - expected)).toBeLessThanOrEqual(tol);
        }
      }),
      RUNS,
    );
  });

  // --- Property (2): recency strictly breaks ties ---------------------------

  // Positive-signal event specs (used to give both articles an EQUAL, strictly
  // positive net signal). scroll_depth uses a proportion in (0,1] so it always
  // contributes a positive amount.
  const positiveSpecArb: fc.Arbitrary<EventSpec> = fc.oneof(
    fc.constantFrom<FeedEventType>('impression', 'dwell', 'expand', 'save', 'share', 'link_out').map(
      (type) => ({ type, scrollProportion: 0, age: 0 }),
    ),
    fc.double({ min: 0.01, max: 1, noNaN: true }).map((scrollProportion) => ({
      type: 'scroll_depth' as FeedEventType,
      scrollProportion,
      age: 0,
    })),
  );

  const tieArb = fc
    .record({
      nowMs: nowMsArb,
      ageA: ageArb,
      ageB: ageArb,
      fillEarly: fillArb,
      // Separate the two embeddings by at least 1.0 so "strictly closer" is a
      // robust comparison free of floating-point ambiguity.
      deltaMag: fc.double({ min: 1, max: 20, noNaN: true }),
      deltaPositive: fc.boolean(),
      // Identical base events for BOTH articles => identical (equal) net signal.
      baseEvents: fc.array(positiveSpecArb, { minLength: 0, maxLength: 4 }),
    })
    .filter((r) => r.ageA !== r.ageB);

  it('(2) with equal net signal but different most-recent times, the centroid is strictly closer to the article whose most recent event is later', () => {
    fc.assert(
      fc.property(tieArb, (t) => {
        // The smaller age => more recent => later most-recent event => "late".
        const lateAge = Math.min(t.ageA, t.ageB);
        const earlyAge = Math.max(t.ageA, t.ageB);
        const lateTime = t.nowMs - lateAge;
        const earlyTime = t.nowMs - earlyAge;

        const fillEarly = t.fillEarly;
        const fillLate = t.fillEarly + (t.deltaPositive ? t.deltaMag : -t.deltaMag);

        // Build each article's events from the SAME base specs at a single
        // anchor time, plus one guaranteed `save`. Equal multisets => equal net
        // signal; a single anchor makes the most-recent time exactly the anchor.
        const buildAt = (id: string, occurredAtMs: number): TimedSignalEvent[] => {
          const out: TimedSignalEvent[] = [{ type: 'save', articleId: id, occurredAtMs }];
          for (const ev of t.baseEvents) {
            out.push(
              ev.type === 'scroll_depth'
                ? { type: ev.type, articleId: id, occurredAtMs, payload: { scrollProportion: ev.scrollProportion } }
                : { type: ev.type, articleId: id, occurredAtMs },
            );
          }
          return out;
        };

        const events = [...buildAt('late', lateTime), ...buildAt('early', earlyTime)];
        const embeddings = new Map<string, number[]>([
          ['late', makeVector(fillLate)],
          ['early', makeVector(fillEarly)],
        ]);

        const result = computeUserEmbedding(events, embeddings, t.nowMs);
        expect(result.status).toBe('updated');
        if (result.status !== 'updated') return;

        expect(result.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
        for (const value of result.embedding) {
          const distLate = Math.abs(value - fillLate);
          const distEarly = Math.abs(value - fillEarly);
          // Strictly biased toward the later article's embedding value.
          expect(distLate).toBeLessThan(distEarly);
        }
      }),
      RUNS,
    );
  });
});

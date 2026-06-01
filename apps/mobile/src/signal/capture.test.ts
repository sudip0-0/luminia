import { describe, it, expect } from 'vitest';
import {
  DWELL_THRESHOLD_MS,
  EMPTY_CAPTURE_STATE,
  SCROLL_DEPTH_STEP,
  VISIBILITY_THRESHOLD,
  initialCaptureState,
  meetsVisibilityThreshold,
  onCardHidden,
  onCardVisible,
  onExpand,
  onLinkOut,
  onScrollDepth,
} from './capture.js';
import type { CaptureState } from './capture.js';

// Unit tests for the pure Signal_Collector capture logic (Requirements 12.1–12.7).
// These exercise the visibility/dwell/skip/scroll classification without a device,
// timers, or React. Property-based coverage of dwell/skip (Property 22) and
// scroll-depth (Property 23) lives in tasks 25.4 and 25.5.

/** Deterministic, sequential id generator so produced events are predictable. */
function sequentialIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const ART = 'article-1';

describe('meetsVisibilityThreshold (Requirement 12.1)', () => {
  it('treats exactly 50% as visible and below 50% as not visible', () => {
    expect(VISIBILITY_THRESHOLD).toBe(0.5);
    expect(meetsVisibilityThreshold(0.5)).toBe(true);
    expect(meetsVisibilityThreshold(0.75)).toBe(true);
    expect(meetsVisibilityThreshold(0.4999)).toBe(false);
    expect(meetsVisibilityThreshold(0)).toBe(false);
  });
});

describe('onCardVisible (Requirements 12.1, 12.2)', () => {
  it('produces one impression event and starts the dwell timer', () => {
    const { state, events } = onCardVisible(initialCaptureState(), ART, 1_000, sequentialIds());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'impression',
      articleId: ART,
      clientEventId: 'id-1',
      payload: {},
    });
    expect(events[0]?.occurredAt).toBe(new Date(1_000).toISOString());
    // Dwell timer started: visibility start time recorded.
    expect(state.articles[ART]?.visibleSinceMs).toBe(1_000);
  });

  it('is idempotent while already visible: no duplicate impression, start time kept', () => {
    const ids = sequentialIds();
    const first = onCardVisible(initialCaptureState(), ART, 1_000, ids);
    const second = onCardVisible(first.state, ART, 2_000, ids);

    expect(second.events).toHaveLength(0);
    expect(second.state).toBe(first.state);
    expect(second.state.articles[ART]?.visibleSinceMs).toBe(1_000);
  });

  it('does not mutate the input state', () => {
    const before = initialCaptureState();
    onCardVisible(before, ART, 1_000, sequentialIds());
    expect(before).toBe(EMPTY_CAPTURE_STATE);
    expect(before.articles[ART]).toBeUndefined();
  });
});

describe('onCardHidden skip vs dwell classification (Requirements 12.4, 12.5)', () => {
  /** Make a state where ART has been visible since `since` ms. */
  function visibleSince(since: number): CaptureState {
    return onCardVisible(initialCaptureState(), ART, since, sequentialIds()).state;
  }

  it('emits a skip when the card exits in under 1500ms', () => {
    const ids = sequentialIds();
    const { events } = onCardHidden(visibleSince(0), ART, 1_499, ids);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'skip', articleId: ART, payload: { dwellMs: 1_499 } });
  });

  it('emits a dwell exactly at the 1500ms boundary (inclusive)', () => {
    expect(DWELL_THRESHOLD_MS).toBe(1500);
    const { events } = onCardHidden(visibleSince(0), ART, 1_500, sequentialIds());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'dwell', articleId: ART, payload: { dwellMs: 1_500 } });
  });

  it('emits a dwell with the tracked duration when visible for longer', () => {
    const { events } = onCardHidden(visibleSince(500), ART, 5_500, sequentialIds());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'dwell', payload: { dwellMs: 5_000 } });
  });

  it('clears the dwell timer after hiding', () => {
    const { state } = onCardHidden(visibleSince(0), ART, 2_000, sequentialIds());
    expect(state.articles[ART]?.visibleSinceMs).toBeNull();
  });

  it('produces exactly one dwell event per visible→hidden cycle', () => {
    // visible → hidden emits one dwell; a second hidden (already hidden) emits nothing.
    const visible = visibleSince(0);
    const ids = sequentialIds();
    const firstHide = onCardHidden(visible, ART, 3_000, ids);
    expect(firstHide.events.filter((e) => e.type === 'dwell')).toHaveLength(1);

    const secondHide = onCardHidden(firstHide.state, ART, 4_000, ids);
    expect(secondHide.events).toHaveLength(0);
  });

  it('is a no-op when the card was never visible', () => {
    const { state, events } = onCardHidden(initialCaptureState(), ART, 1_000, sequentialIds());
    expect(events).toHaveLength(0);
    expect(state).toBe(EMPTY_CAPTURE_STATE);
  });

  it('clamps negative elapsed (clock skew) to a 0ms skip', () => {
    const { events } = onCardHidden(visibleSince(5_000), ART, 4_000, sequentialIds());
    expect(events[0]).toMatchObject({ type: 'skip', payload: { dwellMs: 0 } });
  });
});

describe('onExpand and onLinkOut (Requirements 12.3, 12.7)', () => {
  it('onExpand produces a single expand event', () => {
    const event = onExpand(ART, 7_000, sequentialIds());
    expect(event).toMatchObject({ type: 'expand', articleId: ART, clientEventId: 'id-1', payload: {} });
    expect(event.occurredAt).toBe(new Date(7_000).toISOString());
  });

  it('onLinkOut produces a single link_out event', () => {
    const event = onLinkOut(ART, 8_000, sequentialIds());
    expect(event).toMatchObject({ type: 'link_out', articleId: ART, clientEventId: 'id-1', payload: {} });
    expect(event.occurredAt).toBe(new Date(8_000).toISOString());
  });
});

describe('onScrollDepth 0.25-increment emission (Requirement 12.6)', () => {
  it('emits on the first cross of the 0.25 step from zero', () => {
    expect(SCROLL_DEPTH_STEP).toBe(0.25);
    const { state, events } = onScrollDepth(initialCaptureState(), ART, 0.25, 1_000, sequentialIds());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'scroll_depth', articleId: ART, payload: { scrollProportion: 0.25 } });
    expect(state.articles[ART]?.maxScrollProportion).toBe(0.25);
  });

  it('does not emit when the rise is below 0.25', () => {
    const { state, events } = onScrollDepth(initialCaptureState(), ART, 0.2, 1_000, sequentialIds());
    expect(events).toHaveLength(0);
    expect(state).toBe(EMPTY_CAPTURE_STATE);
  });

  it('does not emit on a smaller subsequent rise but emits once the step is reached', () => {
    const ids = sequentialIds();
    const first = onScrollDepth(initialCaptureState(), ART, 0.25, 1_000, ids); // emits (max → 0.25)
    const small = onScrollDepth(first.state, ART, 0.4, 2_000, ids); // +0.15, no emit
    expect(small.events).toHaveLength(0);
    expect(small.state).toBe(first.state);

    const reached = onScrollDepth(small.state, ART, 0.5, 3_000, ids); // 0.5 - 0.25 = 0.25, emit
    expect(reached.events).toHaveLength(1);
    expect(reached.events[0]).toMatchObject({ payload: { scrollProportion: 0.5 } });
    expect(reached.state.articles[ART]?.maxScrollProportion).toBe(0.5);
  });

  it('does not emit when scrolling back upward (max never decreases)', () => {
    const ids = sequentialIds();
    const advanced = onScrollDepth(initialCaptureState(), ART, 0.5, 1_000, ids); // emits, max → 0.5
    const back = onScrollDepth(advanced.state, ART, 0.1, 2_000, ids); // below max, no emit
    expect(back.events).toHaveLength(0);
    expect(back.state.articles[ART]?.maxScrollProportion).toBe(0.5);
  });

  it('emits across multiple successive 0.25 steps to full depth', () => {
    const ids = sequentialIds();
    let state = initialCaptureState();
    const emitted: number[] = [];
    for (const p of [0.25, 0.5, 0.75, 1.0]) {
      const r = onScrollDepth(state, ART, p, 1_000, ids);
      state = r.state;
      for (const e of r.events) emitted.push(e.payload.scrollProportion as number);
    }
    expect(emitted).toEqual([0.25, 0.5, 0.75, 1.0]);
  });

  it('clamps proportions onto the 0..1 scale', () => {
    const ids = sequentialIds();
    const over = onScrollDepth(initialCaptureState(), ART, 1.5, 1_000, ids);
    expect(over.events[0]).toMatchObject({ payload: { scrollProportion: 1 } });

    const under = onScrollDepth(initialCaptureState(), ART, -0.5, 1_000, ids);
    expect(under.events).toHaveLength(0);
  });
});

describe('per-article isolation', () => {
  it('tracks dwell and scroll independently per article', () => {
    const ids = sequentialIds();
    let state = initialCaptureState();
    state = onCardVisible(state, 'a', 0, ids).state;
    state = onCardVisible(state, 'b', 100, ids).state;

    const hideA = onCardHidden(state, 'a', 200, ids); // 200ms → skip
    expect(hideA.events[0]).toMatchObject({ type: 'skip', articleId: 'a' });
    // b is still being tracked.
    expect(hideA.state.articles['b']?.visibleSinceMs).toBe(100);

    const scrollB = onScrollDepth(hideA.state, 'b', 0.25, 300, ids);
    expect(scrollB.events[0]).toMatchObject({ type: 'scroll_depth', articleId: 'b' });
    // a's scroll max is untouched.
    expect(scrollB.state.articles['a']?.maxScrollProportion).toBe(0);
  });
});

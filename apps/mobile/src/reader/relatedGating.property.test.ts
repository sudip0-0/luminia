import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  goDeeperDecision,
  GO_DEEPER_MIN_RELATED,
  GO_DEEPER_MAX_SHOWN,
} from './relatedGating.js';

// Feature: lumina, Property 37: The "Go deeper" section is gated by the
// related-count threshold. Validates Requirements 19.4, 19.5.

describe('Property 37 — "Go deeper" gating (Req 19.4, 19.5)', () => {
  it('shows iff related count >= 3, displaying min(n, 5)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (n) => {
        const decision = goDeeperDecision(n);
        if (n < GO_DEEPER_MIN_RELATED) {
          expect(decision).toEqual({ show: false, shownCount: 0 });
        } else {
          expect(decision.show).toBe(true);
          expect(decision.shownCount).toBe(Math.min(n, GO_DEEPER_MAX_SHOWN));
          expect(decision.shownCount).toBeLessThanOrEqual(GO_DEEPER_MAX_SHOWN);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('omits the section at the boundary n = 2 and shows it at n = 3', () => {
    expect(goDeeperDecision(2).show).toBe(false);
    expect(goDeeperDecision(3)).toEqual({ show: true, shownCount: 3 });
  });
});

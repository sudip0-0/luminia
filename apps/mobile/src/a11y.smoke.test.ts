import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Lightweight a11y smoke checks: core interactive components declare
 * accessibilityLabel (and often accessibilityRole) in source.
 */
describe('accessibility smoke', () => {
  it('FeedCard exposes an accessibilityLabel', () => {
    const src = readFileSync(join(here, 'components/FeedCard.tsx'), 'utf8');
    expect(src).toContain('accessibilityLabel');
    expect(src).toContain('accessibilityRole="button"');
  });

  it('App tab bar uses accessibilityState.selected', () => {
    const src = readFileSync(join(here, 'App.tsx'), 'utf8');
    expect(src).toContain('accessibilityState={{ selected: tab === t }}');
    expect(src).toContain('accessibilityRole="tab"');
  });

  it('Search input has an accessibilityLabel', () => {
    const src = readFileSync(join(here, 'screens/SearchScreen.tsx'), 'utf8');
    expect(src).toContain('accessibilityLabel="Search Lumina"');
  });

  it('Auth primary CTA is labeled', () => {
    const src = readFileSync(join(here, 'screens/AuthScreen.tsx'), 'utf8');
    expect(src).toContain("accessibilityLabel={mode === 'login' ? 'Sign in' : 'Create account'}");
  });
});

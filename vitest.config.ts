import { defineConfig } from 'vitest/config';

// Root Vitest config. Runs in single-execution mode via `vitest run`.
// Property-based tests use fast-check at a minimum of 100 generated iterations each.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/*.{test,spec}.ts',
      'apps/**/*.{test,spec}.ts',
      'apps/**/*.{test,spec}.tsx',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.expo/**'],
  },
});

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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/shared/src/**/*.ts',
        'packages/api/src/auth/**/*.ts',
        'packages/api/src/ready.ts',
        'apps/mobile/src/api/**/*.ts',
        'apps/mobile/src/session/secureTokenStore.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.property.test.ts', '**/dist/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

// Unit tests cover pure modules only (no SvelteKit plugin; tsconfig extends a generated file, so it is not read here).
export default defineConfig({
  oxc: { tsconfig: false } as any,
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // Measurement only for now: no thresholds yet, they will follow once the baseline is known.
      // Only files imported by tests are counted (Svelte components are not unit tested).
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      // src/test-utils: fakes of browser APIs (OPFS, IndexedDB) used by the unit tests, not application code
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/generated/**', '**/*.generated.*', 'src/test-utils/**'],
    },
  },
});

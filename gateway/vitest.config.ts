import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      // Measurement only for now: no thresholds yet, they will follow once the baseline is known.
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/generated/**', '**/*.generated.*'],
    },
  },
});

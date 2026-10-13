import { defineConfig } from 'vitest/config';
// Tests share one Postgres database (schema is reset per file), so files run sequentially.
export default defineConfig({
  test: {
    fileParallelism: false,
    coverage: {
      // Measurement only for now: no thresholds yet, they will follow once the baseline is known.
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/generated/**', '**/*.generated.*'],
    },
  },
});

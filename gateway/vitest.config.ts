// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
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

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/schema.d.ts', '**/.svelte-kit/**', 'web/build/**', 'desktop/target/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // Jellyfin/Seerr JSON is validated at the edge, DTO-mapped before leaving the backend
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  {
    // the Windows app's bundled pages and its init-script fragment: plain browser scripts
    files: ['desktop/app/ui/**/*.js', 'desktop/app/src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { window: 'readonly', document: 'readonly', Document: 'readonly', Element: 'readonly', EventTarget: 'readonly', Node: 'readonly' },
    },
  },
  {
    // the TV shells (Tizen, shared): browser modules for Chromium 85 (Tizen 6.5) plus node tests and the config check
    files: ['tizen/**/*.{js,mjs}', 'tv-shared/**/*.{js,mjs}', 'webos/**/*.{js,mjs}'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', fetch: 'readonly', AbortController: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', sessionStorage: 'readonly', performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
  },
  {
    // the Tizen shells' page scripts: classic scripts (file:// pages load no modules)
    files: ['tizen/app/setup.js', 'webos/app/setup.js', 'tv-shared/setup-core.js'],
    languageOptions: { sourceType: 'script' },
  },
);

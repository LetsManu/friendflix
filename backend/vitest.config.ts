// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
// Tests share one Postgres database (schema is reset per file), so files run sequentially.
export default defineConfig({ test: { fileParallelism: false } });

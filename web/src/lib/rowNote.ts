// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The text a row can show under one of its cards (see `notes` of Row.svelte); every part is optional and a missing one is left out. */
export interface RowNote { meta?: string; fresh?: string; reason?: string }

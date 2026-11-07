// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import type { Item } from '#lib/api';

/** TV: the card that currently has focus (set by Card.svelte); the focus tile follows it after it settles. */
export const tvFocus = writable<Item | null>(null);

/** TV: the rank of the focused card when it sits in a ranked ("Top 10") row; `id` ties it to the card so a stale value never labels another row. */
export const tvRank = writable<{ id: string; n: number } | null>(null);

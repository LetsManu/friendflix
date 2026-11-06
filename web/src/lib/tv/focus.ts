// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import type { Item } from '#lib/api';

/** TV: the card that currently has focus (set by Card.svelte); the focus tile follows it after it settles. */
export const tvFocus = writable<Item | null>(null);

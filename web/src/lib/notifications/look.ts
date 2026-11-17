// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { t, type TKey } from '#lib/i18n';
import type { Category } from './types';

export type IconName = 'download' | 'tv' | 'film' | 'crown' | 'record' | 'alert' | 'vote' | 'users' | 'bell';
export type Tone = 'ok' | 'info' | 'acc' | 'warn' | 'gold' | 'neutral';
export type ActionKey = 'notes.action.view' | 'notes.action.devices' | 'notes.action.update' | 'notes.action.open';

const ICONS: Record<Category, IconName> = { downloads: 'download', devices: 'tv', series: 'film', achievements: 'crown', livetv: 'record', system: 'alert', requests: 'vote', social: 'users', other: 'bell' };
export const iconOf = (c: Category): IconName => ICONS[c];

export function toneOf(c: Category, kind?: string): Tone {
  if (kind === 'download_expiring' || kind === 'access_soon') return 'warn';
  return c === 'downloads' ? 'ok' : c === 'devices' ? 'info' : c === 'system' ? 'acc' : c === 'achievements' ? 'gold' : 'neutral';
}

export function actionKeyOf(c: Category, kind: string): ActionKey {
  if (kind === 'update_available') return 'notes.action.update';
  if (c === 'downloads' || c === 'series') return 'notes.action.view';
  if (c === 'devices') return 'notes.action.devices';
  return 'notes.action.open';
}

/** Section heading: today / the last six days / the month (with the year when it is not this one). */
export function sectionLabel(key: string, lang: string): string {
  // the notes.* keys are registered with the locales (Task 5); until then they are not in TKey
  if (key === 'today' || key === 'week') return get(t)(`notes.section.${key}` as TKey);
  const [y, m] = key.split('-').map(Number);
  const month = new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15)));
  return y === new Date().getFullYear() ? month : `${month} ${y}`;
}

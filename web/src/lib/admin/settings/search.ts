// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The search of Admin → Einstellungen (spec "Settings tidy-up"): over every setting the page knows, the Live-TV ones included while
 * Live TV is installed, by label, key, help and option labels in the current language; case and accents do not matter. A result names
 * its tab; choosing it opens `?setting=<KEY>` (nothing is edited in the list). The read-only server values are not settings: not searched.
 */
import type { SettingsGroupView } from './api';
import { enumOptions, keyHelp, keyLabel } from './form';
import { tabOfGroup, type SettingsTab } from './tabs';

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 30;

/** lower case, without combining marks ("Überg" → "uberg") */
export const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export interface SettingHit { key: string; label: string; tab: SettingsTab | 'livetv' }

/**
 * The settings matching every word of `q` (at least 2 characters): those with every word in the label first, then those with every word
 * in label or key, then the rest (help, option labels); each in registry order; at most 30.
 */
export function searchSettings(q: string, groups: readonly SettingsGroupView[]): SettingHit[] {
  if (q.trim().length < SEARCH_MIN) return [];
  const words = fold(q).split(/\s+/).filter(Boolean);
  const found: Array<SettingHit & { rank: number; at: number }> = [];
  for (const g of groups) {
    if (g.id === 'server') continue;
    for (const item of g.items) {
      const label = keyLabel(item.key);
      const l = fold(label), k = fold(item.key);
      const rest = fold([keyHelp(item.key), ...(item.kind === 'enum' ? enumOptions(item).map((o) => o.label) : [])].join(' '));
      if (!words.every((w) => l.includes(w) || k.includes(w) || rest.includes(w))) continue;
      const rank = words.every((w) => l.includes(w)) ? 0 : words.every((w) => l.includes(w) || k.includes(w)) ? 1 : 2;
      found.push({ key: item.key, label, tab: tabOfGroup(g.id), rank, at: found.length });
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.at - b.at).slice(0, SEARCH_MAX).map(({ key, label, tab }) => ({ key, label, tab }));
}

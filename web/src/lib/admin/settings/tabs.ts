// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The tabs of Admin → Einstellungen (spec "Settings tidy-up"): which registry groups each tab shows, the tab of a group or a key (for
 * `?setting=<KEY>` deep links and the search), and which tabs hold unsaved edits. The `livetv` group lives in Admin → Live-TV →
 * Einstellungen; the read-only server values sit on *Allgemein*.
 */
import type { SettingGroup, SettingsGroupView } from './api';

export const SETTINGS_TABS = ['general', 'signin', 'media', 'playback', 'updates', 'notifications'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** the groups of each tab, in the order their cards are shown */
export const TAB_GROUPS: Record<SettingsTab, readonly SettingGroup[]> = {
  general: ['general', 'health', 'sessions'],
  signin: ['signin'],
  media: ['media', 'requests', 'sources', 'recommendations'],
  playback: ['playback', 'downloads'],
  updates: ['updates'],
  notifications: ['notifications', 'push'],
};

const TAB_OF = new Map<string, SettingsTab>(SETTINGS_TABS.flatMap((t) => TAB_GROUPS[t].map((g) => [g, t] as const)));

/** the tab of a registry group ('livetv': the Live-TV area); a group this version does not know shows on *Allgemein* */
export const tabOfGroup = (g: SettingGroup): SettingsTab | 'livetv' => (g === 'livetv' ? 'livetv' : TAB_OF.get(g) ?? 'general');

/** the `?tab=` parameter: anything unknown (or none) is *Allgemein* */
export const tabOf = (param: string | null | undefined): SettingsTab => ((SETTINGS_TABS as readonly string[]).includes(param ?? '') ? (param as SettingsTab) : 'general');

/** the tab that shows a key (a read-only server value: *Allgemein*); null for a key the page does not list */
export function tabOfKey(key: string, groups: readonly SettingsGroupView[]): SettingsTab | 'livetv' | null {
  const g = groups.find((x) => x.items.some((i) => i.key === key));
  if (!g) return null;
  return g.id === 'server' ? 'general' : tabOfGroup(g.id);
}

/** the tabs with unsaved edits (their tab shows a dot) */
export function dirtyTabs(changes: Readonly<Record<SettingGroup, Record<string, unknown>>>): Set<SettingsTab> {
  const out = new Set<SettingsTab>();
  for (const [g, values] of Object.entries(changes)) {
    const t = tabOfGroup(g as SettingGroup);
    if (t !== 'livetv' && values && Object.keys(values).length) out.add(t);
  }
  return out;
}

/** the address of a tab (the default tab has no parameter) */
export const tabHref = (t: SettingsTab): string => (t === 'general' ? '/admin/settings' : `/admin/settings?tab=${t}`);

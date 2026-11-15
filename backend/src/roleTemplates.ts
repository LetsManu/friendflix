// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { areasOf, type Areas } from './areas.js';
import { DEFAULT_PERMS, PERM_KEYS, type PermKey } from './perms.js';
import type { RolePatch } from './roleWrite.js';
// roles.ts is part of the roles.ts ↔ rolecat.ts cycle (rolecat imports this module): DEFAULT_ROLES is only read inside functions
import { DEFAULT_ROLES } from './roles.js';

/**
 * The start points of a new role (roles redesign spec §4.4). Familie, Freund and Gast store nothing: the new role reads "Standard" and
 * follows later code-default changes of its base. Nur Live-TV and Leer store their patch. A template role starts with no channel group.
 */
export const ROLE_PRESET_KEYS = ['family', 'friend', 'guest', 'liveOnly', 'empty'] as const;
export type RolePresetKey = (typeof ROLE_PRESET_KEYS)[number];
type Base = 'family' | 'friend' | 'guest';

const off = (keys: readonly PermKey[]) => Object.fromEntries(keys.map((k) => [k, false])) as Partial<Record<PermKey, boolean>>;

export const ROLE_PRESETS: Record<RolePresetKey, { base: Base; patch: Partial<RolePatch> }> = {
  family: { base: 'family', patch: {} },
  friend: { base: 'friend', patch: {} },
  guest: { base: 'guest', patch: {} },
  liveOnly: { base: 'friend', patch: { libraries: [], download: false, perms: { ...off(['requests', 'party', 'partySchedule', 'comments', 'liveRecord']), liveTv: true } } },
  empty: { base: 'guest', patch: { libraries: [], download: false, perms: off(PERM_KEYS) } },
};

/** a preset as `matrix.templates` lists it, with the areas a new role from it has */
export interface RoleTemplatePreset { key: RolePresetKey; base: Base; patch: Partial<RolePatch>; areas: Areas }

/** the areas of a preset: its base's code defaults with the patch on top */
function presetAreas(key: RolePresetKey): Areas {
  const { base, patch } = ROLE_PRESETS[key];
  const { perms, ...fields } = patch;
  return areasOf({ ...DEFAULT_ROLES[base], ...DEFAULT_PERMS[base], ...fields, ...perms });
}

/** the presets the new-role dialog offers, in order; Nur Live-TV only while Live TV is installed */
export function rolePresets(livetv: boolean): RoleTemplatePreset[] {
  return ROLE_PRESET_KEYS.filter((k) => livetv || k !== 'liveOnly').map((key) => ({ key, base: ROLE_PRESETS[key].base, patch: structuredClone(ROLE_PRESETS[key].patch), areas: presetAreas(key) }));
}

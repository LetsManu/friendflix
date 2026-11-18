// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The codename list (A–Z cinema snacks, one per major version): /codenames.json at the repo root (shared with
 * backend/src/version.ts and scripts/release.mjs). The release version and codename come from the backend (build.ts).
 */
import list from '../../../../codenames.json';

export interface Codename { readonly id: string; readonly name: string }

export const CODENAMES: readonly Codename[] = list;

/** "1.2.3" → "1.2" (the easter egg card shows major.minor) */
export const shortVersion = (v: string): string => v.split('.').slice(0, 2).join('.');

/** codename entry by its name (the backend sends names), else by the major version; null when unknown */
export function codenameEntry(name: string | null | undefined, version?: string): Codename | null {
  const byName = name ? CODENAMES.find((c) => c.name === name) : undefined;
  if (byName) return byName;
  const major = Number(String(version ?? '').split('.')[0]);
  return Number.isInteger(major) && major >= 1 ? (CODENAMES[major - 1] ?? null) : null;
}

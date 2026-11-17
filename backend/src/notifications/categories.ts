// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Text } from '../i18n.js';

export type Category = 'downloads' | 'devices' | 'series' | 'achievements' | 'livetv' | 'system' | 'requests' | 'social' | 'other';

export const CATEGORIES: readonly Category[] = ['downloads', 'devices', 'series', 'achievements', 'livetv', 'system', 'requests', 'social', 'other'];

const SERIES = new Set(['episode', 'digest', 'available', 'available_all', 'leaving', 'reminder']);
const SYSTEM = new Set(['disk_low', 'flow_mail_cap', 'pin_locked', 'playback_check']);
const SOCIAL = new Set(['party_invite', 'list_invite', 'recommend']);

/** Category of a notification kind (the filter chips of the notifications center). */
export function categoryOf(kind: string): Category {
  if (kind.startsWith('download_')) return 'downloads';
  if (kind === 'tv_paired' || kind === 'device_pending') return 'devices';
  if (SERIES.has(kind)) return 'series';
  if (kind === 'achievement') return 'achievements';
  if (kind.startsWith('livetv.')) return 'livetv';
  if (/^(update_|syscheck_|deletion_|access_)/.test(kind) || SYSTEM.has(kind)) return 'system';
  if (/^(poll_|request_|media_)/.test(kind) || kind === 'approval') return 'requests';
  if (SOCIAL.has(kind)) return 'social';
  return 'other';
}

/** Kinds that always stand alone: every row is its own group. Mirrored in the migration's backfill. */
export const NEVER_GROUPED: ReadonlySet<string> = new Set([
  'update_available', 'update_failed', 'syscheck_problem', 'pin_locked',
  'deletion_requested', 'deletion_done', 'deletion_failed', 'deletion_restored',
  'access_ended', 'access_soon',
]);

/** Key part of a title: a plain text is itself, a message its key, a join its parts' keys joined by `+`.
 *  Only one join level counts: a join inside a join contributes an empty part (the SQL backfill in migration 60 does the same). */
const textKey = (t: Text, nested = false): string => {
  if (typeof t === 'string') return t;
  if ('join' in t) return nested ? '' : t.join.map((x) => textKey(x, true)).join('+');
  return t.key;
};

/**
 * Group key of a notification: `<kind>|<message key>` (plain titles: the text; a join: the keys joined by `+`).
 * Never-grouped kinds get `<kind>|id:<id>` and need the id of the row.
 */
export function groupKey(kind: string, title: Text, id?: number): string {
  if (NEVER_GROUPED.has(kind)) {
    if (id === undefined) throw new Error(`groupKey: ${kind} needs the notification id`);
    return `${kind}|id:${id}`;
  }
  return `${kind}|${textKey(title)}`;
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Kids profile admin (person page, Profile tab): the backend's limits and its error codes as honest texts. Unit-tested in profiles.test.ts. */
import { ApiError } from '#lib/api';
import { tr } from '#lib/i18n';
import type { TKey } from '#lib/i18n';
import { errorText } from '#lib/ui/action';

/** profiles per account (backend/src/profiles.ts MAX_PROFILES) */
export const MAX_PROFILES = 5;
/** the age caps of a kids profile (KIDS_RATINGS, the DB check) */
export const CAPS = [0, 6, 12] as const;
export type Cap = (typeof CAPS)[number];
/** the text of one cap ("ab 6 Jahren"), shared with the account's own profile editor */
export const capLabel = (n: number): string => tr(`kids.profiles.rating${n}` as TKey);

export type ProfileOp = 'update' | 'create' | 'delete';
const code = (e: unknown): string | undefined => (e instanceof ApiError ? (e.body as { error?: string } | null)?.error : undefined);

/** what the person reads when a profile write fails: one text per backend code, the generic one otherwise */
export function profileError(e: unknown, op: ProfileOp): string {
  switch (code(e)) {
    case 'max_profiles': return tr('adminPeople.profiles.errMax', { n: MAX_PROFILES });
    case 'name_taken': return tr('adminPeople.detail.profiles.nameTaken');
    case 'deletion_in_progress': return tr('adminPeople.profiles.errDeleting');
    case 'owner_not_kids': return tr('adminPeople.profiles.errOwnerKids');
    case 'not_kids': return tr('adminPeople.profiles.errNotKids');
    case 'owner_profile': case 'owner_not_deletable': return tr('adminPeople.profiles.errOwnerDelete');
    case 'not_kids_profile': return tr('adminPeople.profiles.errNotKidsDelete');
    case 'not_found': return tr('adminPeople.profiles.errGone');
    case 'jellyfin': return tr(op === 'update' ? 'adminPeople.profiles.errMediaUpdate' : op === 'create' ? 'adminPeople.profiles.errMediaCreate' : 'adminPeople.profiles.errMediaDelete');
    default: return errorText(e);
  }
}

/** the list on screen is out of date after this error: the change was stored anyway (media server), the profile is gone, or the account is being deleted */
export function reloadAfter(e: unknown, op: ProfileOp): boolean {
  const c = code(e);
  return (c === 'jellyfin' && op === 'update') || c === 'not_found' || c === 'deletion_in_progress';
}

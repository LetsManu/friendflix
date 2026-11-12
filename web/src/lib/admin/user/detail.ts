// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin user detail page (/admin/users/<id>): API shapes (backend/src/routes/adminUsers.ts), tabs, header pills, Authentik errors. */
import { ApiError } from '#lib/api';
import { fmtDate, tr } from '#lib/i18n';
import { errorText } from '#lib/ui/action';
import type { Tone } from '#lib/ui/StatusPill.svelte';

export interface MfaState { totp: boolean; webauthn: boolean; static: boolean }
export interface DetailUser {
  id: string; name: string; email: string | null; role: string; disabled: boolean; lockedReason: string | null
  accessUntil: string | null; createdAt: string; lastActive: string | null; avatar: string | null
  /** scheduled deletion (locked as 'deletion' until then); null = none */
  deletionAt: string | null
}
export interface DetailProfile { id: string; name: string; kids: boolean; maxRating: string | null; avatar: string | null; lastUsed: string | null; isOwner: boolean; hasPin: boolean }
export interface DetailDevice { id: string; name: string | null; lastSeen: string; approved: boolean; sessions: number }
export interface DetailLicense {
  id: string; status: string; title: string; seriesName: string | null; season: number | null; episode: number | null; profileId: string; validUntil: string
}
export interface Totals { hours: number; streams: number }
/** linked account health: ok null = cannot be checked (unknown, never "broken") */
export interface LinkHealth { ok: boolean | null }
export interface UserDetail {
  user: DetailUser;
  /** null = no Authentik API (or Authentik down) */
  mfa: MfaState | null;
  /** which Authentik actions the backend can do */
  authentik: { recovery: boolean; mfaSetup: boolean };
  totals: { d7: Totals; d30: Totals; all: Totals; downloads: number; requests: number };
  linked: { jellyfin: LinkHealth & { username: string | null }; requests: LinkHealth & { id: number | null } };
  profiles: DetailProfile[];
  devices: DetailDevice[];
  licenses: DetailLicense[];
}

export const DETAIL_TABS = ['overview', 'rights', 'check', 'profiles', 'devices', 'downloads', 'activity', 'audit'] as const;
export type DetailTab = typeof DETAIL_TABS[number];
/** the tab of `?tab=`; the old `limits` links open Rechte */
export const detailTab = (v: string | null): DetailTab => (v === 'limits' ? 'rights' : DETAIL_TABS.includes(v as DetailTab) ? (v as DetailTab) : 'overview');

export interface Pill { tone: Tone; label: string; icon?: string }
const LOCK_LABEL: Record<string, string> = { manual: 'lockedManual', expired: 'lockedExpired', deletion: 'lockedDeletion' };
const WEEK = 7 * 86_400_000;

/** "Deletion on {date}" (header and user list) */
export const deletionLabel = (at: string): string => tr('adminPeople.detail.status.deletionOn', { date: fmtDate(at, { dateStyle: 'medium' }) });

/** status pills of the header: active | locked (with reason; a scheduled deletion with its date), plus the access end when there is one */
export function statusPills(u: Pick<DetailUser, 'disabled' | 'lockedReason' | 'accessUntil'> & { deletionAt?: string | null }, now = Date.now()): Pill[] {
  const out: Pill[] = u.disabled && u.lockedReason === 'deletion' && u.deletionAt
    ? [{ tone: 'err', label: deletionLabel(u.deletionAt), icon: 'lock' }]
    : u.disabled
      ? [{ tone: 'err', label: tr(`adminPeople.detail.status.${(u.lockedReason && LOCK_LABEL[u.lockedReason]) || 'locked'}` as 'adminPeople.detail.status.locked'), icon: 'lock' }]
      : [{ tone: 'ok', label: tr('adminPeople.detail.status.active') }];
  if (u.accessUntil) {
    const soon = Date.parse(u.accessUntil) - now <= WEEK;
    out.push({ tone: soon ? 'warn' : 'info', label: tr('adminPeople.detail.status.until', { date: fmtDate(u.accessUntil, { dateStyle: 'medium' }) }), icon: 'calendar' });
  }
  return out;
}

/**
 * The header's lock action: lock an active account, unlock a locked one; when its access has ended, extend access
 * instead (an unlock would not last: the backend refuses it with 409 access_expired, the expiry tick would lock again).
 * A deletion lock is restored (deletion/restore; an account whose access has ended stays locked as expired).
 */
export function lockAction(u: Pick<DetailUser, 'disabled' | 'lockedReason' | 'accessUntil'>, now = Date.now()): 'lock' | 'unlock' | 'extend' | 'restore' {
  if (!u.disabled) return 'lock';
  if (u.lockedReason === 'deletion') return 'restore';
  const ended = u.accessUntil !== null && Date.parse(u.accessUntil) <= now;
  return u.lockedReason === 'expired' || ended ? 'extend' : 'unlock';
}

/** 2FA chips: one per method; none = warning; null = unknown */
export function mfaChips(mfa: MfaState | null): Pill[] {
  if (!mfa) return [{ tone: 'muted', label: tr('adminPeople.detail.mfa.unknown') }];
  const on = (['totp', 'webauthn', 'static'] as const).filter((k) => mfa[k]);
  if (!on.length) return [{ tone: 'warn', label: tr('adminPeople.detail.mfa.none') }];
  return on.map((k) => ({ tone: 'ok', label: tr(`adminPeople.detail.mfa.${k}`) }));
}

/** clear texts for the Authentik actions (recovery e-mail, 2FA setup) */
export function akError(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { error?: string } | null)?.error;
    if (code === 'recovery_not_configured') return tr('adminPeople.detail.ak.notConfigured');
    if (code === 'authentik_user_not_found') return tr('adminPeople.detail.ak.noUser');
    if (e.status === 501) return tr('adminPeople.detail.ak.notSupported');
    if (e.status === 503) return tr('adminPeople.detail.ak.unavailable');
  }
  return errorText(e);
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Einstellungen → Benachrichtigungen, *Branding an Authentik übertragen* (backend/src/akBranding.ts): the preview
 * (GET /api/admin/authentik/branding: name, logo URL, sender; never the SMTP password) and the transfer (POST `{ smtp }`). The SMTP
 * settings go only with `smtp: true`, which needs a fresh sign-in: a 401 `reauth_required` runs the in-place sign-in and sends once more.
 * Each part (brand, e-mail stage) answers on its own and becomes one result line here.
 */
import { isReauthError, reauthenticate } from '#lib/account/reauth';
import { api, ApiError } from '#lib/api';
import { hasKey } from '#lib/i18n';
import { docsHref } from '../syscheck';
import type { ResultTone, Translate } from './mail';

export type AkPartCode = 'permission' | 'token_invalid' | 'not_found' | 'no_email_stage' | 'unreachable' | 'error';
/** the brand's `done` says whether a logo went along; `global_settings`: the stage sends with Authentik's global mail settings */
export type AkPart = { state: 'done'; logo?: boolean } | { state: 'skipped'; code: 'nothing_to_send' | 'global_settings' }
  | { state: 'failed'; code: AkPartCode; permission?: string };
export interface AkSyncResult { brand: AkPart; stage: AkPart }
export interface AkBranding {
  /** the Authentik API is configured (else the card stays hidden) */
  available: boolean;
  title: string;
  logoUrl: string | null;
  from: string | null;
  /** `available`: mail is set up, so the SMTP settings can go along */
  smtp: { available: boolean; host: string | null; port: number; tls: 'starttls' | 'tls' | 'none'; hasUser: boolean };
}

const URL_ = '/api/admin/authentik/branding';
/** where a classic (redirecting) sign-in comes back to: this card's tab */
const BACK = '/admin/settings?tab=notifications';
/** the docs section on the Authentik mails and the service account's extra permissions */
export const AK_BRANDING_GUIDE = docsHref('authentik.md#10b-e-mails-in-the-friendflix-look');

export const loadAkBranding = (): Promise<AkBranding> => api<AkBranding>(URL_);

/** Sends the transfer; after a 401 `reauth_required` it asks for a fresh sign-in and sends once more (a second refusal is thrown). */
export async function syncAkBranding(smtp: boolean): Promise<AkSyncResult> {
  const send = () => api<AkSyncResult>(URL_, { method: 'POST', body: { smtp } });
  try {
    return await send();
  } catch (e) {
    if (!isReauthError(e) || !(await reauthenticate(BACK))) throw e;
  }
  return send();
}

const K = 'settings.mail.authentik';
const CODE = /^[a-z][a-z0-9_]{0,59}$/;
/** a Django permission codename (`app_label.codename`); anything else is not shown */
const PERM = /^[a-z][a-z0-9_]{0,59}\.[a-z][a-z0-9_]{0,59}$/;
const codeKey = (code: string) => (CODE.test(code) && code !== 'permission' && hasKey(`${K}.code.${code}`) ? `${K}.code.${code}` : `${K}.code.error`);

/** one result line: done (ok), skipped (warn), failed (err, the part's name, the reason and a refused call's permission) */
export function partText(part: 'brand' | 'stage', r: AkPart, smtp: boolean, tr: Translate): { tone: ResultTone; text: string } {
  if (r.state === 'done') {
    const key = part === 'brand' ? (r.logo === false ? 'brandDoneName' : 'brandDone') : smtp ? 'stageSmtpDone' : 'stageDone';
    return { tone: 'ok', text: tr(`${K}.${key}`) };
  }
  if (r.state === 'skipped') return { tone: 'warn', text: tr(r.code === 'global_settings' ? `${K}.stageSkippedGlobal` : `${K}.stageSkipped`) };
  const reason = r.code === 'permission'
    ? r.permission && PERM.test(r.permission) ? tr(`${K}.code.permission`, { permission: r.permission }) : tr(`${K}.code.permissionAny`)
    : tr(codeKey(r.code));
  return { tone: 'err', text: tr(`${K}.failed`, { part: tr(`${K}.part.${part}`), reason }) };
}

const ROUTE_ERRORS: Record<string, ResultTone> = { reauth_required: 'warn', mail_not_configured: 'warn', authentik_unavailable: 'warn', rate_limited: 'warn', forbidden: 'err' };

/**
 * the line for a transfer that did not run (refused by the route, a sign-in given up, offline); only the `forbidden` code reads as a
 * question of rights: another 403 (an expired tab token, `csrf`) is the generic "try again"
 */
export function syncErrorText(e: unknown, tr: Translate): { tone: ResultTone; text: string } {
  let code = 'failed';
  if (e instanceof ApiError) {
    const c = (e.body as { error?: unknown } | null)?.error;
    code = typeof c === 'string' && Object.prototype.hasOwnProperty.call(ROUTE_ERRORS, c) ? c : e.status === 429 ? 'rate_limited' : 'failed';
  }
  return { tone: ROUTE_ERRORS[code] ?? 'err', text: tr(`${K}.error.${code}`) };
}

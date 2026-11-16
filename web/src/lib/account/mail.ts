// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mail for people (E-mail stage B): the account page's switches (GET/PUT /api/account/mail, owner profile only) and the public
 * unsubscribe page (/mail/unsubscribe, POST /api/public/mail/unsubscribe with the token in the JSON body, never in the URL).
 */
import { api, ApiError } from '#lib/api';

/** the mail types everyone can switch, and the four only admins get (backend MAIL_PREF_TYPES, same order); welcome and invitations have no switch */
export const PERSON_MAIL_TYPES = ['available', 'recording', 'licence', 'digest'] as const;
export const ADMIN_MAIL_TYPES = ['update', 'updatefailed', 'syscheck', 'storage'] as const;
export const MAIL_TYPES = [...PERSON_MAIL_TYPES, ...ADMIN_MAIL_TYPES] as const;
export type MailType = (typeof MAIL_TYPES)[number];
/** what the backend answers: every person switch, and the admin switches for an admin only */
export type MailPrefs = Partial<Record<MailType, boolean>>;

/** the backend's token shape (mail/unsubscribe.ts): v1.<user id>.<type>.<43-char base64url mac> */
const TOKEN = /^v1\.([0-9a-f-]{36})\.([a-z]{1,20})\.([A-Za-z0-9_-]{43})$/;
const isMailType = (v: string): v is MailType => (MAIL_TYPES as readonly string[]).includes(v);

/** the mail type a token is for (its readable third part), or null when it cannot be a link from a mail */
export function unsubscribeType(token: string): MailType | null {
  const m = TOKEN.exec(token);
  return m && isMailType(m[2]!) ? m[2] : null;
}

/** the page's button: switch the token's type off (`on: false`) or back on. Only the backend checks the token's signature. */
export async function postUnsubscribe(token: string, on: boolean): Promise<'ok' | 'invalid' | 'limited' | 'failed'> {
  try {
    await api('/api/public/mail/unsubscribe', { method: 'POST', body: { t: token, on } });
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) return 'invalid';
    if (e instanceof ApiError && e.status === 429) return 'limited';
    return 'failed';
  }
}

/** the account card: whether this server sends mail, whether the account has an address, whether it is an admin, and the switches */
export type MailState = { configured: boolean; hasAddress: boolean; admin: boolean; prefs: MailPrefs };
export const loadMailPrefs = (): Promise<MailState> => api('/api/account/mail');

/** saves one switch at once; rejects when it was not saved (the card then flips it back) */
export async function saveMailPref(type: MailType, on: boolean): Promise<MailPrefs> {
  return (await api<{ prefs: MailPrefs }>('/api/account/mail', { method: 'PUT', body: { type, on } })).prefs;
}

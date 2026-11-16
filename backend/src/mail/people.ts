// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { userLanguage, type Language } from '../i18n.js';
import { isMailAddress, recipientKey } from './address.js';
import { enqueueMail } from './outbox.js';
import { mailConfigured } from './transport.js';

/**
 * Mail for people (docs/superpowers/specs/2026-11-16-mail-design.md, "Preferences (stage B)", "Admin alerts and digest (stage C)"):
 * one switch per mail type, stored account-level in user_prefs.data.mail (`{ [type]: boolean }`, missing = the type's default), and
 * who gets a person mail at all. Mail is account level: it goes to users.email, never to a kids profile of its own. No valid
 * address, a disabled account, an account whose access ended (access_until passed, before the expiry tick locks it), mail not set
 * up, no PUBLIC_URL or the type switched off -> no outbox row; the in-app notice is unchanged. An admin type (the admin alerts) goes
 * only to an account whose role is `admin`: a switch stored as on by anyone else counts for nothing.
 * Type names are letters only: the unsubscribe token carries the type as `[a-z]{1,20}`.
 */
/** the switches everyone has; `digest` (the weekly recap by mail) is opt-in */
export const PERSON_MAIL_TYPES = ['available', 'recording', 'licence', 'digest'] as const;
/** the admin alert switches: listed, settable and mailed for admins only */
export const ADMIN_MAIL_TYPES = ['update', 'updatefailed', 'syscheck', 'storage'] as const;
export const MAIL_PREF_TYPES = [...PERSON_MAIL_TYPES, ...ADMIN_MAIL_TYPES] as const;
export type MailPrefType = (typeof MAIL_PREF_TYPES)[number];
export type AdminMailType = (typeof ADMIN_MAIL_TYPES)[number];
/** the kinds a person mail can have: one per switch, and the welcome mail (no switch) */
export type PersonMailKind = MailPrefType | 'welcome';

/** each switch without a stored choice: on, except the opt-in digest */
export const MAIL_PREF_DEFAULTS: Readonly<Record<MailPrefType, boolean>> = Object.freeze({
  available: true, recording: true, licence: true, digest: false, update: true, updatefailed: true, syscheck: true, storage: true,
});

export function isMailPrefType(v: unknown): v is MailPrefType {
  return typeof v === 'string' && (MAIL_PREF_TYPES as readonly string[]).includes(v);
}

export function isAdminMailType(v: unknown): v is AdminMailType {
  return typeof v === 'string' && (ADMIN_MAIL_TYPES as readonly string[]).includes(v);
}

/** every type, its default unless a boolean is stored; anything else stored (a non-boolean, an unknown key) is ignored */
function toPrefs(raw: unknown): Record<MailPrefType, boolean> {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(MAIL_PREF_TYPES.map((t) => [t, typeof o[t] === 'boolean' ? o[t] : MAIL_PREF_DEFAULTS[t]])) as Record<MailPrefType, boolean>;
}

/** the switches an account has: every type for an admin, the person types for everyone else (account page, data export) */
export function visibleMailPrefs(prefs: Record<MailPrefType, boolean>, admin: boolean): Partial<Record<MailPrefType, boolean>> {
  return admin ? prefs : Object.fromEntries(PERSON_MAIL_TYPES.map((t) => [t, prefs[t]]));
}

export async function readMailPrefs(ctx: Pick<Ctx, 'db'>, userId: string): Promise<Record<MailPrefType, boolean>> {
  const r = await ctx.db.query<{ mail: unknown }>("select data->'mail' mail from user_prefs where user_id = $1", [userId]);
  return toPrefs(r.rows[0]?.mail);
}

/**
 * Sets one switch, merged into user_prefs.data.mail in SQL (the other keys of user_prefs and the other switches stay, also against
 * a concurrent write). Switching a type off drops that person's queued mail of the type: a mail waiting out a backoff or an outage
 * must not arrive after the person said no. A row already being sent (under its lease) finishes.
 */
export async function setMailPref(ctx: Pick<Ctx, 'db'>, userId: string, type: MailPrefType, on: boolean): Promise<Record<MailPrefType, boolean>> {
  const r = await ctx.db.query<{ mail: unknown }>(
    `insert into user_prefs(user_id, data) values ($1, jsonb_build_object('mail', jsonb_build_object($2::text, $3::boolean)))
     on conflict (user_id) do update set
       data = user_prefs.data || jsonb_build_object('mail',
         (case when jsonb_typeof(user_prefs.data->'mail') = 'object' then user_prefs.data->'mail' else '{}'::jsonb end)
           || jsonb_build_object($2::text, $3::boolean)),
       updated_at = now()
     returning data->'mail' mail`,
    [userId, type, on],
  );
  if (!on) await ctx.db.query("delete from mail_outbox where user_id = $1 and kind = $2 and state = 'queued'", [userId, type]);
  return toPrefs(r.rows[0]?.mail);
}

export interface MailRecipient { to: string; lang: Language; name: string }

/**
 * The one SQL condition for "this account may get person mail" (on `users u`): not disabled and its access not ended. The enqueue
 * (mailRecipient) and the worker's last check before the send (personMailBlock) both use it, so they can never disagree.
 */
const ACTIVE_ACCOUNT = 'not u.disabled and (u.access_until is null or u.access_until > now())';

/** Where and in which language a person mail of `kind` goes, or null when none may be queued (see the module comment). */
export async function mailRecipient(ctx: Pick<Ctx, 'db' | 'cfg'>, userId: string, kind: PersonMailKind): Promise<MailRecipient | null> {
  // without PUBLIC_URL a mail has no link to the app (and no unsubscribe link)
  if (!mailConfigured(ctx.cfg) || !publicOrigin(ctx.cfg)) return null;
  const u = (await ctx.db.query<{ email: string | null; name: string; role: string }>(
    `select u.email, u.name, u.role from users u where u.id = $1 and ${ACTIVE_ACCOUNT}`, [userId])).rows[0];
  if (!u?.email || !isMailAddress(u.email)) return null;
  if (isAdminMailType(kind) && u.role !== 'admin') return null;
  if (isMailPrefType(kind) && !(await readMailPrefs(ctx, userId))[kind]) return null;
  return { to: u.email, lang: await userLanguage(ctx, userId), name: u.name };
}

/** why the worker drops a queued person mail unsent (see personMailBlock) */
export type PersonMailBlock = 'inactive' | 'not_admin' | 'address_changed' | 'unsubscribed';

/**
 * Why a queued person mail of `kind` must not go out now, or null when it may: `inactive` (the account is gone, disabled or its
 * access ended), `not_admin` (an admin type whose recipient's role is no longer `admin`), `address_changed` (the account's address
 * is no longer the one the row was queued for: changed, removed or no longer valid; compared by the keyed hash `rcptKey`, so a mail
 * never goes to an old address) or `unsubscribed` (the type is switched off). The worker asks right before each send, so a switch
 * turned off, an address changed, an admin demoted or an account locked after the row was queued (the enqueue read the old state)
 * still stops the mail. One query.
 */
export async function personMailBlock(
  ctx: Pick<Ctx, 'db' | 'encKey'>, userId: string, kind: PersonMailKind, rcptKey: string,
): Promise<PersonMailBlock | null> {
  const r = (await ctx.db.query<{ email: string | null; role: string; mail: unknown }>(
    `select u.email, u.role, p.data->'mail' mail from users u left join user_prefs p on p.user_id = u.id
      where u.id = $1 and ${ACTIVE_ACCOUNT}`, [userId])).rows[0];
  if (!r) return 'inactive';
  if (isAdminMailType(kind) && r.role !== 'admin') return 'not_admin';
  if (!r.email || !isMailAddress(r.email) || recipientKey(ctx.encKey, r.email) !== rcptKey) return 'address_changed';
  return isMailPrefType(kind) && !toPrefs(r.mail)[kind] ? 'unsubscribed' : null;
}

/** Queues a person mail: the outbox row id, or null when nobody is to be mailed or the dedupe key was used before. */
export async function mailPerson(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string, kind: PersonMailKind, params: Record<string, unknown>, dedupe: string): Promise<string | null> {
  const r = await mailRecipient(ctx, userId, kind);
  if (!r) return null;
  return enqueueMail(ctx, { kind, to: r.to, userId, lang: r.lang, params, dedupe });
}

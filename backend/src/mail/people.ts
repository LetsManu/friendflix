// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { userLanguage, type Language } from '../i18n.js';
import { isMailAddress } from './address.js';
import { enqueueMail } from './outbox.js';
import { mailConfigured } from './transport.js';

/**
 * Mail for people (docs/superpowers/specs/2026-11-16-mail-design.md, "Preferences (stage B)"): one switch per mail type, stored
 * account-level in user_prefs.data.mail (`{ [type]: boolean }`, missing = on), and who gets a person mail at all. Mail is account
 * level: it goes to users.email, never to a kids profile of its own. No valid address, a disabled account, mail not set up, no
 * PUBLIC_URL or the type switched off -> no outbox row; the in-app notice is unchanged.
 */
export const MAIL_PREF_TYPES = ['available', 'recording', 'licence'] as const;
export type MailPrefType = (typeof MAIL_PREF_TYPES)[number];
/** the kinds a person mail can have: one per switch, and the welcome mail (no switch) */
export type PersonMailKind = MailPrefType | 'welcome';

export function isMailPrefType(v: unknown): v is MailPrefType {
  return typeof v === 'string' && (MAIL_PREF_TYPES as readonly string[]).includes(v);
}

/** every type, on unless stored as `false`; anything else stored (a non-boolean, an unknown key) is ignored */
function toPrefs(raw: unknown): Record<MailPrefType, boolean> {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(MAIL_PREF_TYPES.map((t) => [t, typeof o[t] === 'boolean' ? o[t] : true])) as Record<MailPrefType, boolean>;
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

/** Where and in which language a person mail of `kind` goes, or null when none may be queued (see the module comment). */
export async function mailRecipient(ctx: Pick<Ctx, 'db' | 'cfg'>, userId: string, kind: PersonMailKind): Promise<MailRecipient | null> {
  // without PUBLIC_URL a mail has no link to the app (and no unsubscribe link)
  if (!mailConfigured(ctx.cfg) || !publicOrigin(ctx.cfg)) return null;
  const u = (await ctx.db.query<{ email: string | null; name: string; disabled: boolean }>(
    'select email, name, disabled from users where id = $1', [userId])).rows[0];
  if (!u || u.disabled || !u.email || !isMailAddress(u.email)) return null;
  if (isMailPrefType(kind) && !(await readMailPrefs(ctx, userId))[kind]) return null;
  return { to: u.email, lang: await userLanguage(ctx, userId), name: u.name };
}

/** Queues a person mail: the outbox row id, or null when nobody is to be mailed or the dedupe key was used before. */
export async function mailPerson(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string, kind: PersonMailKind, params: Record<string, unknown>, dedupe: string): Promise<string | null> {
  const r = await mailRecipient(ctx, userId, kind);
  if (!r) return null;
  return enqueueMail(ctx, { kind, to: r.to, userId, lang: r.lang, params, dedupe });
}

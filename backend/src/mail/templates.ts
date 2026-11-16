// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { msg, renderKnown, type Language, type MsgKey, type Param, type Text } from '../i18n.js';
import { mailBrand, type MailBrand } from './brand.js';
import { layout, safeHref, type LayoutInput } from './html.js';
import type { MailPrefType } from './people.js';
import { unsubscribeToken, unsubscribeUrls } from './unsubscribe.js';

/** the kinds of mail the outbox sends: the admin's test mail, the one-offs without a switch, and one kind per mail switch */
export type MailKind = 'test' | 'welcome' | 'invite' | MailPrefType;

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ cid: string; filename: string; content: Buffer; contentType: 'image/png' }>;
  headers: Record<string, string>;
}

/** a header value is one line: any line break or control character becomes a space */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** a notice text as it travels in the encrypted params: a plain string or a message reference (i18n.ts `Text`) */
const text: z.ZodType<Text> = z.lazy(() => z.union([
  z.string(),
  z.object({ key: z.string(), params: z.record(z.string(), param).optional() }),
  z.object({ join: z.array(text), sep: z.string().optional() }),
])) as unknown as z.ZodType<Text>;
const param: z.ZodType<Param> = z.lazy(() => z.union([z.number(), z.object({ date: z.string() }), text])) as unknown as z.ZodType<Param>;

/** the params of each kind, checked at render time (a row queued by an older or broken caller fails instead of rendering half a mail) */
const PARAMS = {
  welcome: z.object({ name: z.string() }),
  invite: z.object({
    link: z.string().refine((s) => safeHref(s) !== null, 'not an http(s) URL'),
    expiresAt: z.iso.datetime({ offset: true }),
    inviter: z.string().min(1),
  }),
  pref: z.object({ title: text, body: text.nullish(), link: z.string().nullish() }),
};

/** what one kind contributes; the frame (brand, layout, attachments, the common headers) is the same for all */
type Parts = Omit<LayoutInput, 'lang' | 'brand'> & { subject: string; headers?: Record<string, string> };

interface Common {
  lang: Language;
  app: string;
  origin: string | null;
  /** the brand's website and legal links, in that order: the start of every footer */
  brandLinks: Array<{ label: string; url: string }>;
}

/** a notice's link as an absolute URL in the app: only a relative path ("/downloads") that stays on the origin, anything else null */
function appLink(origin: string, link: string): string | null {
  if (!/^\/(?![/\\])/.test(link)) return null;
  try {
    const u = new URL(link, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

const settingsLink = (c: Common, origin: string) => ({ label: msg(c.lang, 'mail.footer.settings'), url: `${origin}/me/account#mail` });

function testMail(c: Common): Parts {
  const { lang, app } = c;
  return {
    subject: msg(lang, 'mail.test.subject', { app }),
    heading: msg(lang, 'mail.test.heading'),
    paragraphs: [msg(lang, 'mail.test.body', { app })],
    ...(c.origin ? { button: { label: msg(lang, 'mail.open', { app }), url: `${c.origin}/` } } : {}),
    reason: msg(lang, 'mail.test.reason', { app }),
    footerLinks: c.brandLinks,
  };
}

/** once per account (stage B Task 3 claims it); links to the mail settings, no unsubscribe (it has no switch) */
function welcomeMail(c: Common, raw: Record<string, unknown>): Parts {
  const { lang, app } = c;
  const name = PARAMS.welcome.parse(raw).name.trim();
  return {
    subject: msg(lang, 'mail.welcome.subject', { app }),
    heading: name ? msg(lang, 'mail.welcome.heading', { name }) : msg(lang, 'mail.welcome.subject', { app }),
    paragraphs: [msg(lang, 'mail.welcome.body', { app }), msg(lang, 'mail.welcome.body2', { app })],
    ...(c.origin ? { button: { label: msg(lang, 'mail.open', { app }), url: `${c.origin}/` } } : {}),
    reason: msg(lang, 'mail.welcome.reason', { app }),
    footerLinks: c.origin ? [...c.brandLinks, settingsLink(c, c.origin)] : c.brandLinks,
  };
}

/** an absolute URL on this instance's PUBLIC_URL origin (scheme, host and port), or null */
function onOrigin(origin: string | null, url: string): string | null {
  if (!origin || safeHref(url) === null) return null;
  try {
    const u = new URL(url);
    return u.origin === origin && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * to a typed address without an account: no settings and no unsubscribe link (nothing to switch), the reason says to ignore it. The
 * button leads to this instance only (the link's origin is PUBLIC_URL's): an invitation mail never points anywhere else.
 */
function inviteMail(c: Common, raw: Record<string, unknown>): Parts {
  const { lang, app } = c;
  const p = PARAMS.invite.parse(raw);
  if (!onOrigin(c.origin, p.link)) throw new Error('mail_invite_link_off_origin');
  const inviter = p.inviter;
  return {
    subject: msg(lang, 'mail.invite.subject', { inviter, app }),
    heading: msg(lang, 'mail.invite.heading'),
    paragraphs: [msg(lang, 'mail.invite.body', { inviter, app }), msg(lang, 'mail.invite.expires', { date: { date: p.expiresAt } })],
    button: { label: msg(lang, 'mail.invite.button'), url: p.link },
    reason: msg(lang, 'mail.invite.reason', { inviter, app }),
    footerLinks: c.brandLinks,
  };
}

/** the per-type mails that are a notice's mail channel: every switch but the digest, which has its own template */
type NoticeMailType = Exclude<MailPrefType, 'digest'>;

/**
 * the paragraph of a per-type mail whose notice has no body: the kind's own line, or a neutral one (the licence notice always has a
 * body; an admin alert says what happened in its title and body)
 */
const KIND_LINE: Record<NoticeMailType, MsgKey> = {
  available: 'mail.available.body', recording: 'mail.recording.body', licence: 'mail.fallback.body',
  update: 'mail.fallback.body', updatefailed: 'mail.fallback.body', syscheck: 'mail.fallback.body', storage: 'mail.fallback.body',
};

/**
 * A notice mailed through a switch (notify(), `Notice.mail`): the notice's title is subject and heading, its body (else the kind's
 * own line) the paragraph, its link the button. It carries the unsubscribe link and the RFC 8058 headers with the token of exactly
 * this recipient and type; without a recipient or a public URL there is no such link, so it is not rendered at all. A text that
 * refers to a message key removed while the mail waited (a release in between) never shows the raw key: the title becomes a neutral
 * subject, the body the kind's line.
 */
function prefMail(c: Common, encKey: Buffer, kind: NoticeMailType, raw: Record<string, unknown>, userId: string | null): Parts {
  const { lang, app } = c;
  const p = PARAMS.pref.parse(raw);
  if (!c.origin) throw new Error('mail_no_public_url');
  if (!userId) throw new Error('mail_no_recipient');
  const urls = unsubscribeUrls(c.origin, unsubscribeToken(encKey, userId, kind));
  const title = renderKnown(lang, p.title) || msg(lang, 'mail.fallback.subject', { app });
  const body = p.body == null ? '' : renderKnown(lang, p.body) ?? '';
  const target = p.link == null ? `${c.origin}/` : appLink(c.origin, p.link);
  return {
    subject: title,
    heading: title,
    paragraphs: [body || msg(lang, KIND_LINE[kind], { app })],
    ...(target ? { button: { label: msg(lang, `mail.${kind}.button`), url: target } } : {}),
    reason: msg(lang, `mail.${kind}.reason`, { app }),
    footerLinks: [...c.brandLinks, settingsLink(c, c.origin), { label: msg(lang, 'mail.footer.unsubscribe'), url: urls.page }],
    headers: { 'List-Unsubscribe': `<${urls.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

function brandLinks(lang: Language, brand: MailBrand) {
  return [
    brand.website ? { label: msg(lang, 'mail.footer.website'), url: brand.website } : null,
    brand.legal.imprint ? { label: msg(lang, 'mail.footer.imprint'), url: brand.legal.imprint } : null,
    brand.legal.privacy ? { label: msg(lang, 'mail.footer.privacy'), url: brand.legal.privacy } : null,
    brand.legal.help ? { label: msg(lang, 'mail.footer.help'), url: brand.legal.help } : null,
  ].filter((l): l is { label: string; url: string } => l !== null);
}

/**
 * Renders a mail of `kind` in `lang`. `params` are checked per kind (a mismatch throws); `o.userId` is the row's user, the only
 * person whose unsubscribe token a per-type mail may carry. An unknown kind throws: there is no generic fallback.
 */
export async function renderMail(
  ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, kind: MailKind, lang: Language, params: Record<string, unknown>, o: { userId: string | null } = { userId: null },
): Promise<RenderedMail> {
  const brand = await mailBrand(ctx);
  const c: Common = { lang, app: brand.name, origin: publicOrigin(ctx.cfg), brandLinks: brandLinks(lang, brand) };
  let parts: Parts;
  switch (kind) {
    case 'test': parts = testMail(c); break;
    case 'welcome': parts = welcomeMail(c, params); break;
    case 'invite': parts = inviteMail(c, params); break;
    case 'available': case 'recording': case 'licence':
    case 'update': case 'updatefailed': case 'syscheck': case 'storage':
      parts = prefMail(c, ctx.encKey, kind, params, o.userId); break;
    // its own template comes with the digest mail itself (stage C, Task 2); until then nothing queues one
    case 'digest': throw new Error('mail_kind_not_rendered');
    default: {
      const never: never = kind;
      throw new Error(`unknown mail kind: ${String(never).slice(0, 40)}`);
    }
  }
  const { subject, headers, ...body } = parts;
  const { html, text: plain } = layout({ lang, brand, ...body });
  return {
    subject: oneLine(subject),
    html, text: plain,
    attachments: brand.symbol ? [{ cid: brand.symbol.cid, filename: 'symbol.png', content: brand.symbol.png, contentType: 'image/png' }] : [],
    headers: Object.fromEntries(Object.entries({ 'Auto-Submitted': 'auto-generated', 'Content-Language': lang, ...headers }).map(([k, v]) => [k, oneLine(v)])),
  };
}

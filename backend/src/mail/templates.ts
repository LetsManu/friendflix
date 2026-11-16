// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { publicOrigin } from '../config.js';
import type { Ctx } from '../ctx.js';
import { msg, type Language } from '../i18n.js';
import { mailBrand } from './brand.js';
import { layout } from './html.js';

/** the kinds of mail the outbox sends; stage A has the admin's test mail only */
export type MailKind = 'test';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ cid: string; filename: string; content: Buffer; contentType: 'image/png' }>;
  headers: Record<string, string>;
}

/** a header value is one line: any line break or control character becomes a space */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

export async function renderMail(ctx: Pick<Ctx, 'db' | 'cfg'>, kind: MailKind, lang: Language, params: Record<string, unknown>): Promise<RenderedMail> {
  void params; // the test mail takes none
  const brand = await mailBrand(ctx);
  const app = brand.name;
  const origin = publicOrigin(ctx.cfg);
  const links = [
    brand.website ? { label: msg(lang, 'mail.footer.website'), url: brand.website } : null,
    brand.legal.imprint ? { label: msg(lang, 'mail.footer.imprint'), url: brand.legal.imprint } : null,
    brand.legal.privacy ? { label: msg(lang, 'mail.footer.privacy'), url: brand.legal.privacy } : null,
    brand.legal.help ? { label: msg(lang, 'mail.footer.help'), url: brand.legal.help } : null,
  ].filter((l): l is { label: string; url: string } => l !== null);
  const { html, text } = layout({
    lang, brand,
    heading: msg(lang, `mail.${kind}.heading`),
    paragraphs: [msg(lang, `mail.${kind}.body`, { app })],
    ...(origin ? { button: { label: msg(lang, 'mail.open', { app }), url: `${origin}/` } } : {}),
    reason: msg(lang, `mail.${kind}.reason`, { app }),
    footerLinks: links,
  });
  return {
    subject: oneLine(msg(lang, `mail.${kind}.subject`, { app })),
    html, text,
    attachments: brand.symbol ? [{ cid: brand.symbol.cid, filename: 'symbol.png', content: brand.symbol.png, contentType: 'image/png' }] : [],
    headers: { 'Auto-Submitted': 'auto-generated', 'Content-Language': lang },
  };
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Language } from '../i18n.js';
import type { MailBrand } from './brand.js';

/**
 * The mail layout (spec "Layout"): one 600 px card on a grey page, built from tables with inline styles only, so it renders in the
 * clients that ignore <style> and in the ones that rewrite colours for dark mode: every cell that holds text sets its own colour and
 * the page and the card set their own background, and the head says the mail is a light design. All text is escaped here; callers
 * pass plain strings.
 */

const PAGE = '#f4f4f6';
const CARD = '#ffffff';
const TEXT = '#1a1d21';
const MUTED = '#5b6370';
const ON_FILL = '#ffffff';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface LayoutInput {
  lang: Language;
  brand: MailBrand;
  heading: string;
  paragraphs: string[];
  /** titled lists after the paragraphs (the weekly recap): plain text items, no links */
  sections?: Array<{ heading: string; items: string[] }>;
  button?: { label: string; url: string };
  /** why the recipient gets this mail */
  reason: string;
  footerLinks: Array<{ label: string; url: string }>;
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** the URL as written when it is an absolute http(s) URL, else null (a link in a mail is never javascript:, mailto: or a relative path) */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const cell = (color: string, size: number, extra = '') => `color:${color};font-family:${FONT};font-size:${size}px;${extra.includes('line-height') ? '' : 'line-height:1.55;'}${extra}`;

function head(b: MailBrand): string {
  const mark = b.symbol
    ? `<td width="48" height="48" style="width:48px;height:48px;font-size:0;line-height:0;"><img src="cid:brand-symbol" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border:0;border-radius:12px;"></td>`
    : `<td width="48" height="48" align="center" valign="middle" bgcolor="${b.fill}" style="width:48px;height:48px;background-color:${b.fill};border-radius:12px;${cell(ON_FILL, 24, 'font-weight:700;line-height:48px;text-align:center;')}">${esc(b.letter)}</td>`;
  const by = b.byline ? `<div style="${cell(MUTED, 13, 'margin:0;')}">${esc(b.byline)}</div>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${mark}`
    + `<td valign="middle" style="padding-left:14px;${cell(TEXT, 18, 'font-weight:700;')}">${esc(b.name)}${by}</td></tr></table>`;
}

export function layout(i: LayoutInput): { html: string; text: string } {
  const b = i.brand;
  const btnUrl = i.button ? safeHref(i.button.url) : null;
  const links = i.footerLinks.map((l) => ({ label: l.label, url: safeHref(l.url) })).filter((l): l is { label: string; url: string } => l.url !== null);
  const paras = i.paragraphs.map((p) => `<tr><td style="padding:0 0 16px 0;${cell(TEXT, 16)}">${esc(p)}</td></tr>`).join('');
  // a list as table rows, not <ul>: clients disagree on list indents and bullets, a row with "•" looks the same everywhere
  const sections = (i.sections ?? []).map((s) => `<tr><td style="padding:0 0 6px 0;${cell(TEXT, 16, 'font-weight:700;')}">${esc(s.heading)}</td></tr>`
    + s.items.map((it, n) => `<tr><td style="padding:0 0 ${n === s.items.length - 1 ? 16 : 4}px 0;${cell(TEXT, 16)}">• ${esc(it)}</td></tr>`).join('')).join('');
  const button = i.button && btnUrl
    ? `<tr><td style="padding:8px 0 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td align="center" bgcolor="${b.fill}" style="background-color:${b.fill};border-radius:8px;${cell(ON_FILL, 16)}">`
      + `<a href="${esc(btnUrl)}" style="display:inline-block;padding:13px 28px;${cell(ON_FILL, 16, 'font-weight:600;text-decoration:none;')}">${esc(i.button.label)}</a>`
      + `</td></tr></table></td></tr>`
    : '';
  const footLinks = links.length
    ? `<tr><td style="padding:12px 0 0 0;${cell(MUTED, 13)}">${links.map((l) => `<a href="${esc(l.url)}" style="${cell(MUTED, 13, 'text-decoration:underline;')}">${esc(l.label)}</a>`).join(' · ')}</td></tr>`
    : '';
  const pre = i.paragraphs[0] ?? i.heading;
  const html = `<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(i.heading)}</title></head>
<body style="margin:0;padding:0;background-color:${PAGE};color:${TEXT};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE};">${esc(pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:100%;max-width:600px;background-color:${CARD};border-radius:12px;"><tr><td height="4" bgcolor="${b.fill}" style="height:4px;font-size:0;line-height:0;background-color:${b.fill};border-radius:12px 12px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px 32px;${cell(TEXT, 16)}">${head(b)}</td></tr>
<tr><td style="padding:16px 32px 8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 16px 0;${cell(TEXT, 22, 'font-weight:700;line-height:1.3;')}">${esc(i.heading)}</td></tr>${paras}${sections}${button}
</table></td></tr>
<tr><td style="padding:8px 32px 28px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e3e5e9;padding:16px 0 0 0;${cell(MUTED, 13)}">${esc(i.reason)}</td></tr>${footLinks}</table></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    i.heading, '', ...i.paragraphs.flatMap((p) => [p, '']),
    ...(i.sections ?? []).flatMap((s) => [s.heading, ...s.items.map((it) => `- ${it}`), '']),
    ...(i.button && btnUrl ? [`${i.button.label}: ${btnUrl}`, ''] : []),
    '-- ', i.reason,
    ...links.map((l) => `${l.label}: ${l.url}`),
    '', b.name,
  ].join('\n');
  return { html, text };
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveTokens } from '../src/brand/colors.js';
import { DEFAULT_BRAND } from '../src/brand/schema.js';

// Mail stage C, Task 7: the four Authentik mail templates share one standalone FriendFlix shell.

const DIR = new URL('../../deploy/authentik/templates/', import.meta.url);
const FILES = ['friendflix-recovery.html', 'friendflix-email-change.html', 'friendflix-reset.html', 'friendflix-confirm.html'] as const;
const HREFS: Record<(typeof FILES)[number], string[]> = {
  'friendflix-recovery.html': ['https://friend.example.com/reset?token={{ token }}'],
  'friendflix-email-change.html': ['https://friend.example.com/confirm-email?token={{ token }}'],
  'friendflix-reset.html': ['{{ url }}'],
  'friendflix-confirm.html': ['{{ url }}'],
};
const read = (f: string) => readFileSync(new URL(f, DIR), 'utf8');
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  const j = s.indexOf(b);
  expect(i, `${a} present`).toBeGreaterThanOrEqual(0);
  expect(j, `${b} present`).toBeGreaterThan(i);
  return s.slice(i + a.length, j);
};
/** the file without its `{# … #}` comments */
const code = (s: string) => s.replace(/\{#[\s\S]*?#\}/g, '');

describe('Authentik mail templates', () => {
  it('all four share one shell', () => {
    const head = FILES.map((f) => between(read(f), '{# ff:head #}', '{# /ff:head #}'));
    const foot = FILES.map((f) => between(read(f), '{# ff:foot #}', '{# /ff:foot #}'));
    expect(head[0]!.length).toBeGreaterThan(200);
    expect(foot[0]!.length).toBeGreaterThan(20);
    for (const h of head) expect(h).toBe(head[0]);
    for (const f of foot) expect(f).toBe(foot[0]);
  });

  it.each(FILES)('%s has one link, to the right place', (f) => {
    const hrefs = [...code(read(f)).matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
    expect(hrefs).toEqual(HREFS[f]);
  });

  it.each(FILES)('%s loads no remote resource', (f) => {
    const s = code(read(f)).replace(/href="[^"]*"/g, '');
    expect(s).not.toContain('<img');
    expect(s).not.toContain('src=');
    expect(s).not.toContain('url(');
    expect(s).not.toContain('@import');
    expect(s).not.toContain('http');
  });

  it.each(FILES)('%s is standalone', (f) => {
    const s = read(f);
    expect(s).not.toContain('{% extends');
    expect(s).toContain('{% load i18n %}');
    expect(s).toContain('{% trans ');
    const before = s.slice(0, s.indexOf('{% load'));
    expect(before.replace(/\{#[^\n]*?#\}/g, '').trim()).toBe('');
    expect(s.split('\n')[0]).toMatch(/^\{# .* #\}$/);
  });

  it.each(FILES)('%s uses the FriendFlix colours', (f) => {
    const s = read(f);
    expect(s).toContain(deriveTokens(DEFAULT_BRAND.accent).accFill);
    for (const c of ['#f4f4f6', '#ffffff', '#1a1d21']) expect(s).toContain(c);
    expect(s).toContain('{# ff:brand: the accent colour');
  });
});

const TXT = FILES.map((f) => f.replace(/\.html$/, '.txt'));
const transStrings = (s: string) => [...code(s).matchAll(/\{% trans "([^"]*)" %\}/g)].map((m) => m[1]!);
const blocktrans = (s: string) => [...code(s).matchAll(/\{% blocktrans[^%]*%\}([\s\S]*?)\{% endblocktrans %\}/g)].map((m) => m[1]!.trim());

describe('Authentik plain-text twins', () => {
  // Authentik renders template_name.replace("html", "txt") for the text part (stages/email/utils.py)
  it.each(FILES)('%s has a .txt twin with the same name', (f) => {
    expect(() => read(f.replace(/\.html$/, '.txt'))).not.toThrow();
  });

  it.each(FILES)('%s twin: balanced blocks, same link and expiry as the HTML, plain text', (f) => {
    const html = read(f);
    const txt = read(f.replace(/\.html$/, '.txt'));
    const t = code(txt);
    expect(txt).toContain('{% load i18n %}');
    expect(txt).toContain('{% autoescape off %}');
    expect(txt.trimEnd().endsWith('{% endautoescape %}')).toBe(true);
    for (const tag of ['autoescape', 'blocktrans']) {
      const open = (t.match(new RegExp(`\\{% ${tag}\\b`, 'g')) ?? []).length;
      const close = (t.match(new RegExp(`\\{% end${tag} %\\}`, 'g')) ?? []).length;
      expect(open, tag).toBe(close);
    }
    const link = HREFS[f][0]!;
    expect(t.split('\n').map((l) => l.trim())).toContain(link);
    expect(code(html)).toContain(link);
    expect(t).toContain('{% blocktrans with expires=expires|timeuntil %}');
    expect(blocktrans(txt)).toEqual(blocktrans(html));
    expect(t).not.toMatch(/<[a-z!/]/i);
    expect(t).not.toContain('&nbsp;');
    expect(t.trimEnd().replace(/\{% endautoescape %\}$/, '').trimEnd().endsWith('FriendFlix')).toBe(true);
  });

  it.each(FILES)('%s twin: its trans strings are the HTML ones', (f) => {
    const htmlStrings = transStrings(read(f));
    const txt = read(f.replace(/\.html$/, '.txt'));
    const own = transStrings(txt);
    expect(own).toHaveLength(2);
    expect(own[0]).toBe(htmlStrings[0]);
    // a text mail has no button: the sentence says "link" instead
    expect(htmlStrings[1]).toContain('button');
    expect(own[1]).toBe(htmlStrings[1]!.replace('the button below', 'the link below'));
    expect(txt.toLowerCase()).not.toContain('button');
  });

  // the address an admin edits in the HTML is in the twin too (else its text part links to the placeholder host)
  it.each(FILES)('%s twin: first line is the HTML\'s edit marker, and its link is the HTML\'s link', (f) => {
    const html = read(f);
    const txt = read(f.replace(/\.html$/, '.txt'));
    const first = html.split('\n')[0]!;
    expect(txt.startsWith(first)).toBe(true);
    const href = [...code(html).matchAll(/href="([^"]*)"/g)].map((x) => x[1]!);
    expect(href).toHaveLength(1);
    expect(first).toContain(href[0]!);
    const links = code(txt).split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l) || l.startsWith('{{ url'));
    expect(links).toEqual(href);
  });

  it.each(FILES)('%s twin: the name line is marked ff:brand, as in the HTML', (f) => {
    const marker = '{# ff:brand: the name #}';
    const htmlLines = read(f).split('\n');
    expect(htmlLines[htmlLines.indexOf(marker) + 1]).toContain('>FriendFlix<');
    const lines = read(f.replace(/\.html$/, '.txt')).split('\n');
    expect(lines[lines.indexOf('FriendFlix') - 1]).toBe(marker);
  });

  it('ships exactly four twins', () => {
    expect(TXT).toHaveLength(4);
  });
});

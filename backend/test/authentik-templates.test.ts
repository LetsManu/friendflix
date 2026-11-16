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

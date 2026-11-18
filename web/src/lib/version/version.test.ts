// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import { CODENAMES, codenameEntry, shortVersion } from './codenames';
import { _resetBuild, appVersion, buildInfo, footerVersion, loadBuild, versionPending } from './build';
import { EGG_START, eggTap, type EggState } from './egg';
import { parseNotes, plainInline } from './notes';
import de from '../i18n/locales/de/index';

describe('codenames', () => {
  it('26 snacks A–Z, each with a line in the German source', () => {
    expect(CODENAMES).toHaveLength(26);
    expect(CODENAMES.map((c) => c.name.normalize('NFD')[0]!.toUpperCase()).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(Object.keys(de.version.snack).sort()).toEqual(CODENAMES.map((c) => c.id).sort());
  });
  it('codenames.ts no longer imports version.json', () => {
    const src = readFileSync(new URL('./codenames.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import .*version\.json/m);
    expect(src).not.toMatch(/APP_VERSION|APP_CODENAME/);
  });
  it('finds an entry by name or major', () => {
    expect(codenameEntry('Brezel')?.id).toBe('brezel');
    expect(codenameEntry(null, '5.1.0')?.id).toBe('eclair');
    expect(codenameEntry('Unknown', 'x')).toBeNull();
    expect(shortVersion('1.10.3')).toBe('1.10');
  });
});

describe('egg taps', () => {
  const run = (times: number[]) => {
    let s: EggState = EGG_START;
    return times.map((t) => { const r = eggTap(s, t); s = r.state; return r; });
  };
  it('hint from the 4th tap, opens on the 7th, then starts over', () => {
    const r = run([0, 100, 200, 300, 400, 500, 600, 700]);
    expect(r.map((x) => x.remaining)).toEqual([null, null, null, 3, 2, 1, null, null]);
    expect(r.map((x) => x.open)).toEqual([false, false, false, false, false, false, true, false]);
  });
  it('a long pause resets the count', () => {
    const r = run([0, 100, 200, 300, 5000]);
    expect(r[3]!.remaining).toBe(3);
    expect(r[4]!.remaining).toBeNull();
    expect(r[4]!.state.count).toBe(1);
  });
});

describe('release notes', () => {
  it('headings, lists, paragraphs; markup becomes text', () => {
    const b = parseNotes('### Streaming\n- **Adaptive** quality, see [docs](https://x)\n- <img src=x onerror=alert(1)>Night `mode`\n  continued\n\nSome &lt;b&gt; text\nmore.\n');
    expect(b).toEqual([
      { kind: 'h', text: 'Streaming' },
      { kind: 'ul', items: ['Adaptive quality, see docs', '<img src=x onerror=alert(1)>Night mode continued'] }, // unknown tags stay visible as text; the page renders it escaped, never as HTML
      { kind: 'p', text: 'Some <b> text more.' },
    ]);
  });
  it('plainInline strips tags but keeps the words', () => {
    expect(plainInline('<kbd>&lt;</kbd> and <kbd>&gt;</kbd>')).toBe('< and >');
    expect(parseNotes('')).toEqual([]);
  });
});

describe('where the version is asked and shown', () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  it('the root layout starts loadBuild once at boot (the footer is not on every layout)', () => {
    expect(src('../../routes/+layout.svelte')).toMatch(/onMount\(\(\) => void loadBuild\(\)\)/);
  });
  it('the footer: version span hidden while pending, width reserved, text from footerVersion', () => {
    const f = src('../Footer.svelte');
    expect(f).toMatch(/class:pending=\{!fv\.visible\}/);
    expect(f).toMatch(/\.version\.pending \{ visibility: hidden; \}/);
    expect(f).toMatch(/\.version \{ min-width: \d+ch;/);
    expect(f).toMatch(/fv = footerVersion\(\$buildInfo\)/);
    expect(f).not.toMatch(/APP_VERSION|version\.json/);
  });
  it('versionPending: waits (bounded) until answered, then null', async () => {
    _resetBuild();
    void loadBuild((() => new Promise<Response>(() => undefined)) as unknown as typeof fetch); // never answers
    const w = versionPending(5);
    expect(w).not.toBeNull();
    await w; // gives up after the bound
    _resetBuild();
    await loadBuild((async () => { throw new Error('down'); }) as unknown as typeof fetch);
    expect(versionPending()).toBeNull();
    _resetBuild();
  });
});

describe('version from the backend', () => {
  const answer = { sha: 'b'.repeat(40), version: '2.3.4', codename: 'Brezel', build: 'release', channel: 'stable', label: '2.3.4' };
  const ok = (body: unknown = answer) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  afterEach(() => _resetBuild());

  it('footer text comes from /api/version, nothing before', async () => {
    expect(footerVersion(null)).toEqual({ visible: false, text: '0.0.0' }); // keeps its width, hidden
    await loadBuild(ok());
    expect(footerVersion(get(buildInfo))).toEqual({ visible: true, text: '2.3.4 · Brezel' });
    expect(footerVersion({ ...answer, build: 'nightly', label: '2.3.4-nightly · bbbbbbb' } as never)).toEqual({ visible: true, text: '2.3.4-nightly · bbbbbbb' });
  });
  it('build: null (the tag lookup had no answer) still shows the version and sends it in the caps', async () => {
    await loadBuild(ok({ ...answer, build: null, channel: null }));
    expect(footerVersion(get(buildInfo))).toEqual({ visible: true, text: '2.3.4 · Brezel' });
    expect(await appVersion()).toBe('2.3.4');
  });
  it('caps send the backend\'s version, 0.0.0 when it is unknown', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify(answer)); }) as unknown as typeof fetch;
    expect(await Promise.all([loadBuild(f), loadBuild(f)])).toHaveLength(2);
    expect(calls).toBe(1);
    expect(await appVersion()).toBe('2.3.4');
    _resetBuild();
    await loadBuild((async () => { throw new Error('down'); }) as unknown as typeof fetch);
    expect(await appVersion()).toBe('0.0.0');
    _resetBuild();
    await loadBuild(ok({ ...answer, version: 'not semver' }));
    expect(await appVersion()).toBe('0.0.0');
    _resetBuild();
    await loadBuild((async () => new Response('x', { status: 500 })) as unknown as typeof fetch);
    expect(await appVersion()).toBe('0.0.0');
  });
});

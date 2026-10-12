import { describe, expect, it } from 'vitest';
import { basePrecache, isShellFont, shellUrls } from './precache';

const HTML = `<link href="./_app/immutable/entry/start.BPnn_j0w.js" rel="modulepreload">
<link href="./_app/immutable/chunks/CRzLMJPS.js" rel="modulepreload">
<link href="./_app/immutable/assets/0.DdEFIxH_.css" rel="stylesheet">
<link href="/favicon.svg" rel="icon">
<script>Promise.all([import("./_app/immutable/entry/start.BPnn_j0w.js"), import("./_app/immutable/entry/app.DGxLNkhK.js")])</script>`;

describe('service worker precache', () => {
  it('collects the shell modules and styles of the offline page', () => {
    expect(shellUrls(HTML).sort()).toEqual([
      '/_app/immutable/assets/0.DdEFIxH_.css',
      '/_app/immutable/chunks/CRzLMJPS.js',
      '/_app/immutable/entry/app.DGxLNkhK.js',
      '/_app/immutable/entry/start.BPnn_j0w.js',
    ]);
  });
  it('keeps only the latin Inter subset', () => {
    expect(isShellFont('/_app/immutable/assets/inter-latin-wght-normal.Dx4kXJAl.woff2')).toBe(true);
    expect(isShellFont('/_app/immutable/assets/inter-latin-ext-wght-normal.DO1Apj_S.woff2')).toBe(false);
    expect(isShellFont('/_app/immutable/assets/inter-cyrillic-wght-normal.DqGufNeO.woff2')).toBe(false);
  });
  it('base list: prerendered pages, icons, shell font; no route chunks', () => {
    const l = basePrecache({ immutable: ['/_app/immutable/nodes/5.x.js', '/_app/immutable/assets/inter-latin-wght-normal.a.woff2', '/_app/immutable/assets/inter-greek-wght-normal.b.woff2'], prerendered: ['/offline'], statics: ['/favicon.svg', '/offline'] });
    expect(l).toEqual(['/offline', '/favicon.svg', '/_app/immutable/assets/inter-latin-wght-normal.a.woff2']);
  });
});

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFireTvViewport, pauseWhenHidden, fireTvDisplayHeight, fireTvOs, isFireTvApp, postFireTv, type FireWin } from './detect';

const UA = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
/** a document with a <head> holding at most one meta tag (the unit tests run without a DOM) */
function fakeDoc(content?: string) {
  const el = () => { const a = new Map<string, string>(); return { getAttribute: (k: string) => a.get(k) ?? null, setAttribute: (k: string, v: string) => void a.set(k, v) }; };
  const metas: Array<ReturnType<typeof el>> = [];
  if (content !== undefined) { const m = el(); m.setAttribute('name', 'viewport'); m.setAttribute('content', content); metas.push(m); }
  return {
    metas,
    querySelector: (sel: string) => (sel === 'meta[name=viewport]' ? metas.find((m) => m.getAttribute('name') === 'viewport') ?? null : null),
    createElement: (tag: string) => { expect(tag).toBe('meta'); return el(); },
    head: { appendChild: (m: ReturnType<typeof el>) => void metas.push(m) },
  };
}
const app = (extra = ' FriendFlixFireTV/3.0.0 FFDisplay/2160', port?: FireWin['FriendFlixTv']): FireWin => ({ navigator: { userAgent: UA + extra }, FriendFlixTv: port, innerWidth: 1920, innerHeight: 1080 });

describe('Fire TV detection', () => {
  it('the marker alone makes the Fire TV app', () => {
    expect(isFireTvApp(app())).toBe(true);
    expect(isFireTvApp({ navigator: { userAgent: UA } })).toBe(false);
    expect(isFireTvApp({ navigator: { userAgent: UA + ' FriendFlixAndroid/3.0.0' } })).toBe(false);
    expect(isFireTvApp(undefined)).toBe(false);
    expect(isFireTvApp({})).toBe(false);
  });
  it('defaults to the page window', () => {
    expect(isFireTvApp()).toBe(false);
    expect(fireTvDisplayHeight()).toBe(1080);
    expect(fireTvOs()).toBeNull();
    expect(postFireTv('exit')).toBe(false);
    expect(applyFireTvViewport()).toBe(false);
  });
  it('display height: 2160 only for a 4K display, else 1080', () => {
    expect(fireTvDisplayHeight(app())).toBe(2160);
    expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/1080'))).toBe(1080);
    expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/4320'))).toBe(2160);
    expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0'))).toBe(1080);
    expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/abc'))).toBe(1080);
    expect(fireTvDisplayHeight(app(' FriendFlixFireTV/3.0.0 FFDisplay/21600'))).toBe(1080);
    expect(fireTvDisplayHeight(undefined)).toBe(1080);
  });
  it('os token', () => {
    expect(fireTvOs(app())).toBe('9/AFTMM');
    expect(fireTvOs({ navigator: { userAgent: 'Mozilla/5.0' } })).toBeNull();
    expect(fireTvOs(undefined)).toBeNull();
  });
  it('posts only inside the app and never throws', () => {
    const sent: string[] = [];
    expect(postFireTv('exit', app(undefined, { postMessage: (m) => sent.push(m) }))).toBe(true);
    expect(sent).toEqual(['exit']);
    expect(postFireTv('exit', { navigator: { userAgent: UA }, FriendFlixTv: { postMessage: (m) => sent.push(m) } })).toBe(false);
    expect(postFireTv('exit', app())).toBe(false); // no port
    expect(postFireTv('exit', app(undefined, {}))).toBe(false); // a port without postMessage
    expect(postFireTv('exit', app(undefined, { postMessage: () => { throw new Error('gone'); } }))).toBe(false);
    expect(postFireTv('exit', undefined)).toBe(false);
    expect(sent).toEqual(['exit']);
  });
  it('calls postMessage on the port (a Java bridge needs its receiver)', () => {
    const port = { sent: [] as string[], postMessage(m: string) { this.sent.push(m); } };
    expect(postFireTv('keepAwake:1', app(undefined, port))).toBe(true);
    expect(port.sent).toEqual(['keepAwake:1']);
  });
  it('viewport is 1920 wide in the app only', () => {
    const document = fakeDoc('width=device-width, initial-scale=1');
    expect(applyFireTvViewport(document as never, { navigator: { userAgent: UA } })).toBe(false);
    expect(document.querySelector('meta[name=viewport]')!.getAttribute('content')).toBe('width=device-width, initial-scale=1');
    expect(applyFireTvViewport(document as never, app())).toBe(true);
    expect(document.querySelector('meta[name=viewport]')!.getAttribute('content')).toBe('width=1920');
    const empty = fakeDoc();
    expect(applyFireTvViewport(empty as never, app())).toBe(true);
    expect(empty.metas).toHaveLength(1);
    expect(empty.metas[0]!.getAttribute('name')).toBe('viewport');
    expect(empty.querySelector('meta[name=viewport]')!.getAttribute('content')).toBe('width=1920');
    expect(applyFireTvViewport(undefined, app())).toBe(false);
  });
  it('pauses when the page is hidden, in the app only', () => {
    const fns = new Set<() => void>();
    const doc = { hidden: false, addEventListener: (_t: string, f: () => void) => void fns.add(f), removeEventListener: (_t: string, f: () => void) => void fns.delete(f) };
    const pause = vi.fn();
    const stop = pauseWhenHidden(pause, doc, app());
    fns.forEach((f) => f()); // visible again: nothing
    expect(pause).not.toHaveBeenCalled();
    doc.hidden = true;
    fns.forEach((f) => f());
    expect(pause).toHaveBeenCalledTimes(1);
    stop();
    expect(fns.size).toBe(0);
    const off = pauseWhenHidden(pause, doc, { navigator: { userAgent: UA } });
    expect(fns.size).toBe(0);
    expect(() => off()).not.toThrow();
    expect(pauseWhenHidden(pause, undefined, app())()).toBeUndefined();
  });
});

describe('with a page window and document', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads the real window and document by default', () => {
    const fns = new Set<() => void>();
    const meta = new Map<string, string>([['name', 'viewport']]);
    vi.stubGlobal('window', { navigator: { userAgent: UA + ' FriendFlixFireTV/3.0.0 FFDisplay/2160' } });
    vi.stubGlobal('document', {
      hidden: true, querySelector: () => ({ getAttribute: (k: string) => meta.get(k) ?? null, setAttribute: (k: string, v: string) => void meta.set(k, v) }),
      addEventListener: (_t: string, f: () => void) => void fns.add(f), removeEventListener: (_t: string, f: () => void) => void fns.delete(f),
    });
    expect(isFireTvApp()).toBe(true);
    expect(fireTvDisplayHeight()).toBe(2160);
    expect(applyFireTvViewport()).toBe(true);
    expect(meta.get('content')).toBe('width=1920');
    const pause = vi.fn();
    const stop = pauseWhenHidden(pause);
    fns.forEach((f) => f());
    expect(pause).toHaveBeenCalledTimes(1);
    stop();
  });
});

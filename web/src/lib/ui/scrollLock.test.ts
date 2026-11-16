// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { classicScrollbar, lockScroll, scrollLockToggle } from './scrollLock';

/**
 * a document double: <html>'s inline style, its client width and the window's inner width; `gutter`: the page reserves the
 * scrollbar's room itself (app.css `scrollbar-gutter: stable`, read from the computed style)
 */
function fakeDoc(innerWidth: number, clientWidth: number, style: { overflow?: string; paddingRight?: string } = {}, gutter = false) {
  const st = { overflow: style.overflow ?? '', paddingRight: style.paddingRight ?? '' };
  const html = { clientWidth, style: st };
  const win = { innerWidth, ...(gutter ? { getComputedStyle: () => ({ scrollbarGutter: 'stable' }) } : {}) };
  return { doc: { documentElement: html, defaultView: win } as unknown as Document, st };
}

describe('lockScroll', () => {
  it('pads by the scrollbar width (no scrollbar-gutter: the fallback)', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const off = lockScroll(doc);
    expect(st.overflow).toBe('hidden');
    expect(st.paddingRight).toBe('15px');
    off();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
  });

  it('with scrollbar-gutter: stable the gutter keeps the room: no padding, fixed bars and content stay put', () => {
    const { doc, st } = fakeDoc(1000, 985, {}, true);
    const off = lockScroll(doc);
    expect(st).toEqual({ overflow: 'hidden', paddingRight: '' });
    off();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
  });

  it('no scrollbar, no padding', () => {
    const { doc, st } = fakeDoc(390, 390);
    const off = lockScroll(doc);
    expect(st.overflow).toBe('hidden');
    expect(st.paddingRight).toBe('');
    off();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
  });

  it('nested locks: the inner unlock keeps the page locked, the last one restores it', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const a = lockScroll(doc);
    const b = lockScroll(doc);
    expect(st).toEqual({ overflow: 'hidden', paddingRight: '15px' });
    b();
    expect(st).toEqual({ overflow: 'hidden', paddingRight: '15px' });
    a();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
  });

  it('restores previous inline values; an existing padding gets the bar added to it', () => {
    const { doc, st } = fakeDoc(1000, 988, { overflow: 'clip', paddingRight: '4px' });
    const off = lockScroll(doc);
    expect(st).toEqual({ overflow: 'hidden', paddingRight: '16px' });
    off();
    expect(st).toEqual({ overflow: 'clip', paddingRight: '4px' });
  });

  it('a hidden overflow nobody holds a lock for is not restored (the lock alone owns the page overflow)', () => {
    const { doc, st } = fakeDoc(1000, 1000, { overflow: 'hidden' });
    const off = lockScroll(doc);
    st.overflow = ''; // whatever set it lets go meanwhile
    off();
    expect(st.overflow).toBe('');
  });

  it('a dialog over a sheet: the sheet closes under the dialog, then the dialog closes: the page scrolls again', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const sheet = scrollLockToggle(doc);
    sheet(true);
    const dialog = lockScroll(doc);
    sheet(false);
    expect(st.overflow).toBe('hidden');
    dialog();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
    // the other order too
    sheet(true);
    const d2 = lockScroll(doc);
    d2();
    expect(st.overflow).toBe('hidden');
    sheet(false);
    expect(st.overflow).toBe('');
  });

  it('scrollLockToggle follows a boolean: repeated values change nothing', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const t = scrollLockToggle(doc);
    t(false);
    expect(st.overflow).toBe('');
    t(true); t(true);
    const other = lockScroll(doc);
    t(false); t(false);
    expect(st.overflow).toBe('hidden'); // the toggle released only its own lock
    other();
    expect(st.overflow).toBe('');
  });

  it('double unlock is harmless', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const a = lockScroll(doc);
    const b = lockScroll(doc);
    b(); b(); b();
    expect(st.overflow).toBe('hidden');
    a(); a();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
    // a lock after all that starts clean
    const c = lockScroll(doc);
    expect(st.overflow).toBe('hidden');
    c();
    expect(st.overflow).toBe('');
  });

  it('two documents keep their own counts; no document (server rendering) is a no-op', () => {
    const one = fakeDoc(1000, 985), two = fakeDoc(800, 800);
    const a = lockScroll(one.doc), b = lockScroll(two.doc);
    a();
    expect(one.st.overflow).toBe('');
    expect(two.st.overflow).toBe('hidden');
    b();
    expect(two.st.overflow).toBe('');
    expect(() => lockScroll()()).not.toThrow();
    expect(() => { const t = scrollLockToggle(); t(true); t(false); }).not.toThrow();
  });
});

describe('classicScrollbar', () => {
  /** a document whose probe box (overflow: scroll) is 100 px wide with `bar` px of scrollbar */
  const probeDoc = (bar: number) => {
    const kids: unknown[] = [];
    const doc = {
      createElement: () => ({ style: {} as Record<string, string>, offsetWidth: 100, clientWidth: 100 - bar }),
      body: { appendChild: (n: unknown) => kids.push(n), removeChild: (n: unknown) => kids.splice(kids.indexOf(n), 1) },
    } as unknown as Document;
    return { doc, kids };
  };
  it('a classic scrollbar takes room; overlay or hidden scrollbars take none; the probe goes again', () => {
    const classic = probeDoc(15);
    expect(classicScrollbar(classic.doc)).toBe(true);
    expect(classic.kids).toHaveLength(0);
    expect(classicScrollbar(probeDoc(0).doc)).toBe(false);
    expect(classicScrollbar()).toBe(false); // no document (server rendering)
  });
});

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lockScroll } from './scrollLock';

/** a document double: <html>'s inline style, its client width and the window's inner width */
function fakeDoc(innerWidth: number, clientWidth: number, style: { overflow?: string; paddingRight?: string } = {}) {
  const st = { overflow: style.overflow ?? '', paddingRight: style.paddingRight ?? '' };
  return { doc: { documentElement: { clientWidth, style: st }, defaultView: { innerWidth } } as unknown as Document, st };
}

describe('lockScroll', () => {
  it('pads by the scrollbar width', () => {
    const { doc, st } = fakeDoc(1000, 985);
    const off = lockScroll(doc);
    expect(st.overflow).toBe('hidden');
    expect(st.paddingRight).toBe('15px');
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
    // the inner lock measured the page already locked (no scrollbar left): it must not change the padding either
    const c = lockScroll(doc);
    (doc.documentElement as unknown as { clientWidth: number }).clientWidth = 1000;
    const d = lockScroll(doc);
    expect(st.paddingRight).toBe('15px');
    d(); c();
    expect(st).toEqual({ overflow: '', paddingRight: '' });
  });

  it('restores previous inline values', () => {
    const { doc, st } = fakeDoc(1000, 988, { overflow: 'clip', paddingRight: '4px' });
    const off = lockScroll(doc);
    expect(st).toEqual({ overflow: 'hidden', paddingRight: '12px' });
    off();
    expect(st).toEqual({ overflow: 'clip', paddingRight: '4px' });
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
  });
});

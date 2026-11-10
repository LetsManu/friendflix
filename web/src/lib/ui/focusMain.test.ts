// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { focusMain } from './focusMain';

describe('focusMain', () => {
  it('focuses main with a transient tabindex that goes on blur', () => {
    const blurListeners: Array<() => void> = [];
    const attrs = new Map<string, string>();
    const main = {
      setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
      focus: vi.fn(() => expect(attrs.get('tabindex')).toBe('-1')),
      addEventListener: (_: string, fn: () => void) => blurListeners.push(fn), blur: vi.fn(() => blurListeners[0]?.()),
    };
    const docL: Record<string, () => void> = {};
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'main' ? main : null), addEventListener: (t: string, fn: () => void) => { docL[t] = fn; }, removeEventListener: (t: string) => { delete docL[t]; } });
    focusMain();
    expect(main.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(attrs.get('tabindex')).toBe('-1');
    docL.pointerdown!(); // a click elsewhere lets go
    expect(main.blur).toHaveBeenCalled();
    expect(attrs.has('tabindex')).toBe(false);
    expect(docL.pointerdown).toBeUndefined();
    vi.stubGlobal('document', { getElementById: () => null });
    expect(() => focusMain()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

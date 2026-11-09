// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuItems, menuKeys, menuMove, moveIndex } from './menuKeys';

describe('menu keys (WAI-ARIA menu button pattern)', () => {
  it('maps the arrows, Home and End; other keys move nothing', () => {
    expect(menuMove('ArrowDown')).toBe('next');
    expect(menuMove('ArrowUp')).toBe('prev');
    expect(menuMove('Home')).toBe('first');
    expect(menuMove('End')).toBe('last');
    for (const k of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'Escape', 'a']) expect(menuMove(k), k).toBeNull();
  });
  it('wraps at both ends, jumps to first / last, and starts from the edge when nothing in the menu has focus', () => {
    expect(moveIndex('next', 0, 4)).toBe(1);
    expect(moveIndex('next', 3, 4)).toBe(0);
    expect(moveIndex('prev', 0, 4)).toBe(3);
    expect(moveIndex('prev', 2, 4)).toBe(1);
    expect(moveIndex('first', 2, 4)).toBe(0);
    expect(moveIndex('last', 0, 4)).toBe(3);
    expect(moveIndex('next', -1, 4)).toBe(0);
    expect(moveIndex('prev', -1, 4)).toBe(3);
    expect(moveIndex('next', 0, 0)).toBe(-1);
  });
});

/** a minimal element double: focus() makes it document.activeElement */
function el(attrs: Record<string, string> = {}, disabled = false) {
  const e = {
    disabled, inert: false,
    getAttribute: (k: string) => attrs[k] ?? null,
    focus: vi.fn(() => { (globalThis as { document?: unknown }).document = { activeElement: e }; }),
  };
  return e;
}
function menu(items: ReturnType<typeof el>[]) {
  const handlers: Array<(e: KeyboardEvent) => void> = [];
  const node = {
    inert: false,
    querySelectorAll: () => items,
    addEventListener: (_t: string, h: (e: KeyboardEvent) => void) => handlers.push(h),
    removeEventListener: vi.fn(),
  };
  const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
    const ev = { key, preventDefault: vi.fn(), ...mods } as unknown as KeyboardEvent;
    for (const h of handlers) h(ev);
    return ev;
  };
  return { node: node as unknown as HTMLElement & { inert: boolean }, press };
}

describe('menuKeys action', () => {
  afterEach(() => { delete (globalThis as { document?: unknown }).document; });
  it('arrows move the focus between enabled items (wrapping), Home / End jump; the page does not scroll', () => {
    const a = el(), b = el({}, true), c = el(), d = el({ 'aria-disabled': 'true' });
    const { node, press } = menu([a, b, c, d]);
    menuKeys(node, { close: vi.fn() });
    expect(menuItems(node)).toEqual([a, c]);
    a.focus();
    const ev = press('ArrowDown');
    expect(c.focus).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
    press('ArrowDown');
    expect(a.focus).toHaveBeenCalledTimes(2); // wrapped
    press('End');
    expect(c.focus).toHaveBeenCalledTimes(2);
    press('Home');
    expect(a.focus).toHaveBeenCalledTimes(3);
    press('ArrowUp');
    expect(c.focus).toHaveBeenCalledTimes(3);
  });
  it('Tab closes the menu, makes it inert and hands the focus to its button (the browser moves on from there)', () => {
    const a = el(), trigger = el();
    const close = vi.fn();
    const { node, press } = menu([a]);
    menuKeys(node, { close, trigger: trigger as unknown as HTMLElement });
    a.focus();
    const ev = press('Tab');
    expect(close).toHaveBeenCalled();
    expect(node.inert).toBe(true);
    expect(trigger.focus).toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
  it('ignores modified keys and keys it does not own; update swaps the options; destroy removes the listener', () => {
    (globalThis as { document?: unknown }).document = { activeElement: null };
    const a = el();
    const close = vi.fn(), close2 = vi.fn();
    const { node, press } = menu([a]);
    const act = menuKeys(node, { close });
    press('ArrowDown', { altKey: true });
    press('Enter');
    expect(a.focus).not.toHaveBeenCalled();
    act.update({ close: close2 });
    press('Tab');
    expect(close).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalled();
    act.destroy();
    expect(node.removeEventListener).toHaveBeenCalled();
    const empty = menu([]);
    menuKeys(empty.node, { close });
    expect(empty.press('ArrowDown').preventDefault).not.toHaveBeenCalled();
  });
});

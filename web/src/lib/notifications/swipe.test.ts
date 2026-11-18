// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swipeToRemove } from './swipe';

/** a 300-px row: an EventTarget with a style and a box */
class Row extends EventTarget {
  style: Record<string, string> = {};
  isConnected = true;
  getBoundingClientRect() { return { width: 300 } as DOMRect; }
}
type P = { type?: string; id?: number; primary?: boolean };
function ev(name: string, x: number, y: number, t: number, p: P = {}) {
  const e = new Event(name, { cancelable: true });
  for (const [k, v] of Object.entries({ pointerType: p.type ?? 'touch', pointerId: p.id ?? 1, isPrimary: p.primary ?? true, clientX: x, clientY: y, timeStamp: t })) Object.defineProperty(e, k, { value: v });
  return e;
}
/** a drag from (200, 50): moves at the given x (one every 50 ms unless times are given), then up */
function drag(row: Row, xs: number[], o: { ys?: number[]; times?: number[]; end?: 'pointerup' | 'pointercancel' } = {}) {
  row.dispatchEvent(ev('pointerdown', 200, 50, 0));
  xs.forEach((x, i) => row.dispatchEvent(ev('pointermove', x, o.ys?.[i] ?? 50, o.times?.[i] ?? (i + 1) * 50)));
  const last = xs.length ? xs[xs.length - 1]! : 200;
  row.dispatchEvent(ev(o.end ?? 'pointerup', last, o.ys?.at(-1) ?? 50, o.times?.at(-1) ?? xs.length * 50));
}
const click = (row: Row) => { const e = new Event('click', { cancelable: true }); row.dispatchEvent(e); return e.defaultPrevented; };

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('swipe to remove', () => {
  it('the row follows the finger to the left (transform and opacity only)', () => {
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove: vi.fn() });
    row.dispatchEvent(ev('pointerdown', 200, 50, 0));
    row.dispatchEvent(ev('pointermove', 195, 50, 10)); // under the lock distance: nothing yet
    expect(row.style.transform).toBeUndefined();
    row.dispatchEvent(ev('pointermove', 140, 52, 300));
    expect(row.style).toEqual({ transition: 'none', transform: 'translateX(-60px)', opacity: String(1 - 0.2 * 0.8) });
  });
  it('past 40 % of the width it slides out and is removed; the click it ends with is swallowed', () => {
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [180, 120, 70], { times: [100, 400, 800] }); // 130 px of 300, slowly
    expect(row.style.transform).toBe('translateX(-300px)');
    expect(row.style.transition).toContain('transform 180ms');
    expect(click(row)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(remove).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(row.style.transform).toBe(''); // still in the page (nothing was removed): it comes back
    vi.advanceTimersByTime(170); // 350 ms after letting go
    expect(click(row)).toBe(false);
  });
  it('a short drag springs back; a fling removes', () => {
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [180, 150], { times: [200, 600] }); // 50 px, slowly
    expect(row.style.transform).toBe('');
    expect(row.style.transition).toContain('transform 260ms cubic-bezier');
    vi.runAllTimers();
    expect(remove).not.toHaveBeenCalled();
    drag(row, [188, 150], { times: [16, 48] }); // 50 px in 48 ms: a fling
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('a vertical move is the scroll; a move to the right, a mouse and a second finger are ignored', () => {
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove: vi.fn() });
    drag(row, [196, 180], { ys: [70, 140] });
    expect(row.style.transform).toBeUndefined();
    drag(row, [230, 260]);
    expect(row.style.transform).toBeUndefined();
    row.dispatchEvent(ev('pointerdown', 200, 50, 0, { type: 'mouse' }));
    row.dispatchEvent(ev('pointermove', 100, 50, 50, { type: 'mouse' }));
    expect(row.style.transform).toBeUndefined();
    row.dispatchEvent(ev('pointerdown', 200, 50, 0));
    row.dispatchEvent(ev('pointerdown', 200, 50, 0, { id: 2, primary: false }));
    row.dispatchEvent(ev('pointermove', 100, 50, 50, { id: 2 }));
    row.dispatchEvent(ev('pointerup', 100, 50, 60, { id: 2 }));
    expect(row.style.transform).toBeUndefined();
    expect(click(row)).toBe(false);
  });
  it('the click stays swallowed until the next touch or 350 ms (a flick inside the tap slop can click late)', () => {
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [188, 186], { times: [16, 24] }); // a short fast flick: gone
    vi.advanceTimersByTime(200);
    expect(click(row)).toBe(true); // a late click of that touch
    expect(click(row)).toBe(true); // (still within the 350 ms)
    vi.advanceTimersByTime(150);
    expect(click(row)).toBe(false);
    drag(row, [180, 150], { times: [200, 600] }); // springs back
    row.dispatchEvent(ev('pointerdown', 10, 10, 700, { type: 'mouse' })); // the next press: its click is its own
    expect(click(row)).toBe(false);
  });
  it('a row sliding out ignores a second swipe: it is removed once', () => {
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [150, 20]);
    vi.advanceTimersByTime(100);
    drag(row, [150, 20]);
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledTimes(1);
    drag(row, [150, 20]); // it stayed (nothing was removed): it can go again
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('a cancelled drag (the browser took over) springs back; disabled rows and a destroyed action do nothing', () => {
    const remove = vi.fn();
    const row = new Row();
    const a = swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [150, 20], { end: 'pointercancel' });
    expect(row.style.transform).toBe('');
    vi.runAllTimers();
    expect(remove).not.toHaveBeenCalled();
    a.update({ remove, enabled: false });
    drag(row, [150, 20]);
    expect(row.style.transform).toBe('');
    vi.runAllTimers();
    expect(remove).not.toHaveBeenCalled();
    a.update({ remove });
    a.destroy();
    drag(row, [150, 20]);
    vi.runAllTimers();
    expect(remove).not.toHaveBeenCalled();
  });
  it('with reduced motion nothing animates: the row goes or comes back at once', () => {
    reduced = true;
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [180, 150], { times: [200, 600] });
    expect(row.style).toMatchObject({ transition: 'none', transform: '' });
    drag(row, [150, 20]);
    expect(remove).toHaveBeenCalledTimes(1); // no slide out first
  });
  it('the app calm mode (html.m-still) counts as reduced motion', () => {
    vi.stubGlobal('document', { documentElement: { classList: { contains: (c: string) => c === 'm-still' } } });
    const remove = vi.fn();
    const row = new Row();
    swipeToRemove(row as unknown as HTMLElement, { remove });
    drag(row, [150, 20]);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

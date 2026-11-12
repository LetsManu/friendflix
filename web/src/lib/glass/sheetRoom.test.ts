// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { roomOf, sheetRoom } from './sheetRoom';

describe('roomOf', () => {
  it('a bottom sheet keeps its height free, a right-hand one its width unless it fills the window', () => {
    expect(roomOf('bottom', { width: 480, height: 301.2 }, 1280)).toEqual({ h: 302, w: 0 });
    expect(roomOf('right', { width: 440, height: 800 }, 1280)).toEqual({ h: 0, w: 440 });
    expect(roomOf('right', { width: 390, height: 844 }, 390)).toEqual({ h: 0, w: 0 });
  });
});

describe('sheetRoom', () => {
  const vars = new Map<string, string>();
  const sheet = (w: number, h: number) => {
    const on = new Map<string, () => void>();
    return {
      offsetWidth: w, offsetHeight: h,
      addEventListener: (k: string, f: () => void) => on.set(k, f), removeEventListener: (k: string) => on.delete(k),
      fire: (k: string) => on.get(k)?.(),
    };
  };
  beforeEach(() => {
    vars.clear();
    vi.stubGlobal('document', { documentElement: { style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) } } });
    vi.stubGlobal('window', { innerWidth: 1280, addEventListener: () => undefined, removeEventListener: () => undefined });
  });

  it('sets --sheet-h while a bottom sheet is open and takes it away when it starts to close', () => {
    const s = sheet(480, 300);
    const a = sheetRoom(s as unknown as HTMLElement);
    expect(vars.get('--sheet-h')).toBe('300px');
    s.fire('outrostart');
    expect(vars.has('--sheet-h')).toBe(false);
    s.fire('introstart'); // an interrupted close: open again
    expect(vars.get('--sheet-h')).toBe('300px');
    a.destroy();
    expect(vars.has('--sheet-h')).toBe(false);
  });

  it('a right-hand sheet sets --sheet-w; the largest room of several open sheets counts', () => {
    const r = sheetRoom(sheet(440, 800) as unknown as HTMLElement, 'right');
    const b1 = sheetRoom(sheet(640, 220) as unknown as HTMLElement);
    const b2 = sheetRoom(sheet(480, 340) as unknown as HTMLElement);
    expect(vars.get('--sheet-w')).toBe('440px');
    expect(vars.get('--sheet-h')).toBe('340px');
    b2.destroy();
    expect(vars.get('--sheet-h')).toBe('220px');
    b1.destroy(); r.destroy();
    expect(vars.size).toBe(0);
  });
});

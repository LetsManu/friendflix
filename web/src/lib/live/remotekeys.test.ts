// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { liveRemote } from './remotekeys';

const store = () => { const m: Record<string, string> = {}; return { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => { m[k] = v; } }; };
const ev = (key: string, keyCode: number) => ({ key, keyCode });

describe('liveRemote', () => {
  it('a browser: keys stay as sent, nothing registered', () => {
    const r = liveRemote({ navigator: { userAgent: 'Mozilla/5.0 Chrome/120' }, location: { search: '' }, sessionStorage: store() });
    expect(r.lg).toBe(false);
    expect(r.keyName(ev('Unidentified', 427))).toBe('Unidentified');
    const e = ev('a', 65);
    expect(r.input(e)).toBe(e);
  });
  it('the Samsung app registers its live keys and names a ChannelUp by code', () => {
    const registerKey = vi.fn();
    const tizen = { tvinputdevice: { registerKey, getKey: (n: string) => ({ code: n === 'ChannelUp' ? 427 : 1 }), getSupportedKeys: () => [] } };
    const r = liveRemote({ navigator: { userAgent: 'x FriendFlixTizen/1.0' }, location: { search: '' }, sessionStorage: store(), tizen });
    expect(registerKey).toHaveBeenCalledWith('ChannelUp');
    expect(registerKey).not.toHaveBeenCalledWith('ChannelList');
    expect(r.keyName(ev('Unidentified', 427))).toBe('ChannelUp');
    expect(r.input({ ...ev('Unidentified', 427), ctrlKey: true })).toEqual({ key: 'ChannelUp', ctrlKey: true, metaKey: undefined, altKey: undefined, shiftKey: undefined });
  });
  it('the LG app uses its table: Info 457, Red 403, PageUp 33 only when unidentified', () => {
    const s = store();
    s.setItem('ff.app', 'webos');
    const r = liveRemote({ navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV)' }, location: { search: '' }, sessionStorage: s });
    expect(r.lg).toBe(true);
    expect(r.keyName(ev('Unidentified', 457))).toBe('Info');
    expect(r.keyName(ev('Unidentified', 403))).toBe('ColorF0Red');
    expect(r.keyName(ev('Unidentified', 33))).toBe('PageUp');
    expect(r.keyName(ev('ArrowUp', 38))).toBe('ArrowUp');
  });
  it('no window: keys stay as sent', () => {
    expect(liveRemote(undefined).keyName(ev('Info', 0))).toBe('Info');
  });
});

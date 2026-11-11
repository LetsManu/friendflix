// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { anonymise, eventsText, CAST_LOG_KEY, CAST_LOG_MAX, castLog, castLogDevices, castReport, clearCastLog, noteCastDevice, readCastLog, scrub } from './castLog';
import type { Store } from './resume';

const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } };
};

describe('scrub', () => {
  it('scrub removes urls, tokens, ids and addresses', () => {
    const out = scrub(
      'load https://friend.example.com/x wss://friend.example.com/socket failed, /media/c/AbC123_-/Videos/1/master.m3u8 id ' + 'a1'.repeat(16) + ' from 192.0.2.7 and 2001:db8::5 via ::1 ' + 'Zz9_-'.repeat(8),
    );
    for (const bad of ['friend.example.com', '/media/c/', 'AbC123', 'a1a1a1', '192.0.2.7', '2001:db8', '::1', 'Zz9_-Zz9_-']) expect(out, bad).not.toContain(bad);
    expect(out).toContain('…');
  });
  it('keeps ordinary event text, clock times and episode labels', () => {
    expect(scrub('loaded S1 E4 from 00:12:30, 2 reconnects')).toBe('loaded S1 E4 from 00:12:30, 2 reconnects');
  });
  it('removes IPv4-mapped IPv6 literals and scheme-relative URLs', () => {
    const out = scrub('peer ::ffff:192.0.2.7 and //friend.example.com/x');
    expect(out).not.toMatch(/192\.0\.2|ffff|friend\.example/);
    expect(scrub('fetch (//friend.example.com/x) failed')).toBe('fetch (… failed');
    expect(scrub('src x=//friend.example.com/y')).toBe('src x=…');
    expect(scrub("at '//friend.example.com/z', \"//friend.example.com/q\"; ,//friend.example.com/r")).not.toMatch(/friend\.example/);
    expect(scrub('S1 E4 a/b//c')).toBe('S1 E4 a/b//c'); // a path inside a word is no URL start
  });
  it('removes full IPv6 literals', () => {
    expect(scrub('peer 2001:0db8:0000:0000:0000:0000:0000:0005 gone')).toBe('peer … gone');
  });
});

describe('cast log', () => {
  it('ring buffer keeps the last 200', () => {
    const s = mem();
    for (let i = 1; i <= 205; i++) castLog({ level: 'info', tag: 'session', text: `entry ${i}` }, i, s);
    const all = readCastLog(s);
    expect(all).toHaveLength(CAST_LOG_MAX);
    expect(all[0]!.text).toBe('entry 6');
    expect(all[199]!).toEqual({ at: 205, level: 'info', tag: 'session', text: 'entry 205' });
  });
  it('scrubs on write, clears, and survives broken storage', () => {
    const s = mem();
    castLog({ level: 'warn', tag: 'network', text: 'to 192.0.2.9' }, 1, s);
    expect(s.data.get(CAST_LOG_KEY)).not.toContain('192.0.2.9');
    clearCastLog(s);
    expect(readCastLog(s)).toEqual([]);
    s.data.set(CAST_LOG_KEY, '{nope');
    expect(readCastLog(s)).toEqual([]);
    s.data.set(CAST_LOG_KEY, JSON.stringify([{ at: 1, level: 'bad', tag: 'x', text: 1 }, { at: 2, level: 'info', tag: 'test', text: 'ok' }]));
    expect(readCastLog(s)).toEqual([{ at: 2, level: 'info', tag: 'test', text: 'ok' }]);
    s.data.set(CAST_LOG_KEY, '{}');
    expect(readCastLog(s)).toEqual([]);
    const throwing: Store = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(() => { castLog({ level: 'info', tag: 'test', text: 'x' }, 1, throwing); clearCastLog(throwing); }).not.toThrow();
    expect(readCastLog(throwing)).toEqual([]);
    expect(() => castLog({ level: 'info', tag: 'test', text: 'x' }, 1, null)).not.toThrow();
  });
});

describe('report', () => {
  it('report anonymises devices', () => {
    const entries = [
      { at: Date.UTC(2026, 10, 10, 12), level: 'info' as const, tag: 'session' as const, text: 'connected to Wohnzimmer-TV' },
      { at: Date.UTC(2026, 10, 10, 12, 1), level: 'error' as const, tag: 'receiver' as const, text: 'Wohnzimmer-TV idle ERROR' },
      { at: Date.UTC(2026, 10, 10, 12, 2), level: 'info' as const, tag: 'session' as const, text: 'connected to Küche' },
    ];
    const r = castReport({ rows: [['Session', 'Connected to Wohnzimmer-TV']], entries, air: '', devices: ['Küche', 'Wohnzimmer-TV'] });
    expect(r.match(/TV 1/g)).toHaveLength(3);
    expect(r.match(/TV 2/g)).toHaveLength(1);
    expect(r).not.toContain('Wohnzimmer');
    expect(r).not.toContain('Küche');
    expect(r).toContain('Session: Connected to TV 1');
  });
  it('anonymises names of earlier sessions kept in the device list, longest name first', () => {
    const s = mem();
    noteCastDevice('Küche', s);
    noteCastDevice('Wohnzimmer-TV', s);
    noteCastDevice('TV', s);
    noteCastDevice('Küche', s);
    expect(castLogDevices(s)).toEqual(['Wohnzimmer-TV', 'TV', 'Küche']);
    castLog({ level: 'info', tag: 'session', text: 'session started · Küche' }, 1, s);
    const entries = readCastLog(s);
    const r = castReport({ rows: [['Playing', 'on TV']], entries: [...entries, { at: 2, level: 'info', tag: 'session', text: 'Wohnzimmer-TV ok' }], air: '', devices: castLogDevices(s) });
    expect(r).not.toContain('Küche');
    expect(r).not.toContain('Wohnzimmer');
    expect(r).toContain('Playing: on TV 1');
    expect(r).toMatch(/session started · TV 2/);
    expect(r).toMatch(/TV 3 ok/);
    expect(r).toMatch(/times UTC[+-]\d\d:\d\d/);
    clearCastLog(s);
    expect(castLogDevices(s)).toEqual([]);
    expect(() => noteCastDevice('x', null)).not.toThrow();
    s.data.set('ff-castlog-devices', '{}');
    expect(castLogDevices(s)).toEqual([]);
  });
  it('scrubs rows and the AirPlay log, and handles empty input', () => {
    const r = castReport({ rows: [['Pass', 'https://friend.example.com/media/c/x']], entries: [], air: 'peer 192.0.2.4', devices: [] });
    expect(r).not.toMatch(/friend\.example|192\.0\.2/);
    expect(r).toContain('(none)');
  });
  it('eventsText anonymises device names like the report and scrubs', () => {
    const t = eventsText([{ at: 0, level: 'info', tag: 'session', text: 'session started · Wohnzimmer-TV' }, { at: 1, level: 'info', tag: 'load', text: 'x https://friend.example.com/a' }], ['Wohnzimmer-TV']);
    expect(t).toContain('session started · TV 1');
    expect(t).not.toMatch(/Wohnzimmer|friend\.example/);
    expect(anonymise('a b', [])).toBe('a b');
  });
});

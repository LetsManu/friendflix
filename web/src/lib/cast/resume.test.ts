// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  CAST_HINT_KEY, CAST_LAST_KEY, castIdOfContentUrl, clearHint, lastDevice, lookupToCastInfo, readHint, rememberDevice, sha256Hex, tokenOfContentUrl, writeHint,
  type CastHint, type CastLookup, type Store,
} from './resume';

const mem = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } };
};
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP-';
const hint: CastHint = { castId: 'ab'.repeat(16), itemId: 'dunmoor-s1e4', device: 'Wohnzimmer-TV', exp: 2_000, at: 1_000 };

describe('hint', () => {
  it('readHint drops expired, malformed and foreign shapes', () => {
    const s = mem();
    writeHint(s, hint);
    expect(readHint(s, 1_500)).toEqual(hint);
    expect(readHint(s, 2_000)).toBeNull();
    s.data.set(CAST_HINT_KEY, JSON.stringify({ ...hint, castId: 'x' }));
    expect(readHint(s, 1_500)).toBeNull();
    s.data.set(CAST_HINT_KEY, '{nope');
    expect(readHint(s, 1_500)).toBeNull();
    s.data.set(CAST_HINT_KEY, '"text"');
    expect(readHint(s, 1_500)).toBeNull();
    s.data.set(CAST_HINT_KEY, JSON.stringify({ ...hint, exp: 'soon' }));
    expect(readHint(s, 1_500)).toBeNull();
    expect(readHint(null, 1_500)).toBeNull();
    const throwing: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readHint(throwing, 1_500)).toBeNull();
    expect(() => { writeHint(throwing, hint); clearHint(throwing); rememberDevice(throwing, 'x'); }).not.toThrow();
    expect(lastDevice(throwing)).toBeNull();
  });

  it('writeHint stores the public handle only and clearHint removes it', () => {
    const s = mem();
    writeHint(s, { ...hint, token: TOKEN, url: 'https://friend.example.com/media/c/x' } as CastHint);
    expect(Object.keys(JSON.parse(s.data.get(CAST_HINT_KEY)!)).sort()).toEqual(['at', 'castId', 'device', 'exp', 'itemId']);
    clearHint(s);
    expect(s.data.has(CAST_HINT_KEY)).toBe(false);
  });

  it('remembers the last device, trimmed and capped at 80 characters', () => {
    const s = mem();
    expect(lastDevice(s)).toBeNull();
    rememberDevice(s, '  Wohnzimmer-TV ');
    expect(lastDevice(s)).toBe('Wohnzimmer-TV');
    rememberDevice(s, '   ');
    expect(lastDevice(s)).toBe('Wohnzimmer-TV');
    rememberDevice(s, 'x'.repeat(120));
    expect(s.data.get(CAST_LAST_KEY)).toHaveLength(80);
  });
});

describe('content URL', () => {
  it('tokenOfContentUrl', () => {
    expect(tokenOfContentUrl(`https://friend.example.com/media/c/${TOKEN}/Videos/abc/master.m3u8`)).toBe(TOKEN);
    expect(tokenOfContentUrl('https://friend.example.com/media/Videos/abc/master.m3u8')).toBeNull();
    expect(tokenOfContentUrl(`https://friend.example.com/media/c/${TOKEN}x/Videos`)).toBeNull();
    expect(tokenOfContentUrl('')).toBeNull();
  });

  it('castIdOfContentUrl uses the first 32 hex of sha256(token)', async () => {
    const url = `https://friend.example.com/media/c/${TOKEN}/Videos/abc/master.m3u8`;
    expect(await castIdOfContentUrl(url, async () => 'ab'.repeat(32))).toBe('ab'.repeat(16));
    // same value as backend/src/cast.ts hashToken(TOKEN).slice(0, 32)
    expect(await castIdOfContentUrl(url, sha256Hex)).toBe('47859fa8dd21f43894d7bd01f6dacc81');
    expect(await castIdOfContentUrl('https://friend.example.com/media/x', sha256Hex)).toBeNull();
    expect(await castIdOfContentUrl(url, async () => { throw new Error('no crypto'); })).toBeNull();
    expect(await castIdOfContentUrl(url, async () => 'zz')).toBeNull();
  });

  it('sha256Hex is lowercase hex of the full digest', async () => {
    expect(await sha256Hex(TOKEN)).toBe('47859fa8dd21f43894d7bd01f6dacc81d3ed74e2fdaf50edd38a68df86722016');
  });
});

describe('lookupToCastInfo', () => {
  const l: CastLookup = {
    castId: 'ab'.repeat(16), itemId: 'dunmoor-s1e5', mediaSourceId: 'ms1', playSessionId: 'ps1', expiresAt: 9_000, runtimeTicks: 27_000_000_000, via: 'chromecast',
    next: false, reported: true, title: 'Wrenfield Pier', seriesName: 'Dunmoor',
    subtitles: [{ index: 3, language: 'deu', title: 'Deutsch' }, { index: 7, title: 'English' }], pins: 1, refused: { count: 0, families: [] },
  };
  it('rebuilds the CastInfo from the receiver URL', () => {
    expect(lookupToCastInfo(l, 'https://friend.example.com/media/c/T/x.m3u8')).toEqual({
      castId: l.castId, expiresAt: 9_000, playSessionId: 'ps1', mediaSourceId: 'ms1', runtimeTicks: 27_000_000_000, startTime: 0,
      contentUrl: 'https://friend.example.com/media/c/T/x.m3u8', contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts',
      title: 'Wrenfield Pier', seriesName: 'Dunmoor',
      subtitles: [{ index: 3, language: 'deu', title: 'Deutsch', url: '' }, { index: 7, title: 'English', url: '' }],
    });
  });
  it('leaves out what the lookup did not carry', () => {
    const { runtimeTicks: _r, seriesName: _s, ...rest } = l;
    const info = lookupToCastInfo(rest, 'u');
    expect('runtimeTicks' in info).toBe(false);
    expect('seriesName' in info).toBe(false);
  });
});

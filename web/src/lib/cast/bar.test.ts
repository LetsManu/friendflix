// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { barHasProgress, barLine, barLine1, barLine2, barLine2Full, barOpens, barTitleFull, splitLine, barProgress, barThumb, barVisible, CASTBAR_H, liveCast, minutesLeft, nextSecondsLeft } from './bar';
import { img } from '#lib/api';
import type { CastSession } from './engine';

describe('cast bar', () => {
  it('liveCast: a session the engine drives (not one only known from the hint)', () => {
    expect(liveCast(null)).toBe(false);
    expect(liveCast({ state: 'detached' } as CastSession)).toBe(false);
    for (const state of ['connecting', 'playing', 'reconnect', 'ended', 'failed'] as const) expect(liveCast({ state } as CastSession)).toBe(true);
  });

  it('barVisible', () => {
    const s = { itemId: 'x' } as CastSession;
    expect(barVisible({ path: '/', tv: false, session: s })).toBe(true);
    expect(barVisible({ path: '/watch/x', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/party/abc', tv: false, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: true, session: s })).toBe(false);
    expect(barVisible({ path: '/', tv: false, session: null })).toBe(false);
  });

  const tf = (k: string, p?: Record<string, unknown>) => (k === 'player.castBar.on' ? `auf ${p?.device}` : k);
  const base = { device: 'Wohnzimmer-TV', posterId: 'p1', subtitle: '', isEpisode: false, position: 30, duration: 120 } as CastSession;

  it('barLine', () => {
    expect(barLine({ ...base, subtitle: 'S1:E2 Second' }, tf)).toBe('S1:E2 Second · auf Wohnzimmer-TV');
    expect(barLine(base, tf)).toBe('auf Wohnzimmer-TV');
  });

  it('barProgress', () => {
    expect(barProgress(base)).toBe(25);
    expect(barProgress({ ...base, duration: 0 })).toBe(0);
    expect(barProgress({ ...base, position: 200 })).toBe(100);
  });

  it('barThumb', () => {
    expect(barThumb({ ...base, isEpisode: true })).toEqual({ src: img('p1', 160), ratio: '16/9' });
    expect(barThumb(base)!.ratio).toBe('2/3');
  });

  it('a live channel from the app: no poster thumbnail, no progress line, nothing to open', () => {
    const live = { ...base, duration: 0, position: 0, isLive: true };
    expect(barThumb(live)).toBeNull();
    expect(barHasProgress(live)).toBe(false);
    expect(barOpens(live)).toBe(false);
    expect(barHasProgress(base)).toBe(true);
    expect(barOpens(base)).toBe(true);
  });

  it('nextSecondsLeft', () => {
    expect(nextSecondsLeft(9100 + 5000, 5000)).toBe(10);
    expect(nextSecondsLeft(1000, 5000)).toBe(0);
    expect(nextSecondsLeft(null, 5000)).toBeNull();
  });

  describe('line 2 (spec §2 states table)', () => {
    const live = { ...base, kind: 'chromecast' as const, state: 'playing' as const, position: 18 * 60 + 42, duration: 47 * 60 + 10 };
    it('playing: device and the minutes left, rounded up', () => {
      expect(barLine2(live, 0, tr)).toEqual({ text: 'Auf Wohnzimmer-TV · noch 29 Min.', tone: 'none', device: 'Wohnzimmer-TV' });
      expect(barLine2({ ...live, position: 19 * 60 + 30 }, 0, tr).text).toBe('Auf Wohnzimmer-TV · noch 28 Min.');
      expect(barLine2({ ...live, position: live.duration - 1 }, 0, tr).text).toBe('Auf Wohnzimmer-TV · noch 1 Min.');
      expect(barLine2({ ...live, paused: true }, 0, tr).tone).toBe('none');
    });
    it('without a duration: just the device', () => {
      expect(barLine2({ ...live, duration: 0 }, 0, tr).text).toBe('Läuft auf Wohnzimmer-TV');
      expect(barLine2({ ...live, position: live.duration }, 0, tr).text).toBe('Läuft auf Wohnzimmer-TV');
    });
    it('connecting names the device', () => {
      expect(barLine2({ ...live, state: 'connecting' }, 0, tr)).toEqual({ text: 'Verbinde mit Wohnzimmer-TV …', tone: 'none' });
    });
    it('reconnect and detached: warning; AirPlay waiting for the picker: the pick hint', () => {
      for (const state of ['reconnect', 'detached'] as const) expect(barLine2({ ...live, state }, 0, tr)).toEqual({ text: 'Verbindung verloren', tone: 'warn' });
      expect(barLine2({ ...live, kind: 'airplay', state: 'reconnect' }, 0, tr, { choose: true })).toEqual({ text: 'Jetzt den Fernseher in der Liste auswählen.', tone: 'none' });
    });
    it('failed: error', () => {
      expect(barLine2({ ...live, state: 'failed' }, 0, tr)).toEqual({ text: 'Konnte auf dem Fernseher nicht abspielen', tone: 'error' });
    });
    it('the offered next episode, with its countdown', () => {
      const next = { itemId: 'e5', label: 'S1:F5 · Wrenfield Pier', startsAt: 10_000 };
      expect(barLine2({ ...live, next }, 4000, tr)).toEqual({ text: 'Auf Wohnzimmer-TV · Als Nächstes: S1:F5 · Wrenfield Pier · in 6 s', tone: 'none', device: 'Wohnzimmer-TV', tail: ' · in 6 s' });
      expect(barLine2({ ...live, state: 'ended', next: { ...next, startsAt: null } }, 4000, tr).text).toBe('Auf Wohnzimmer-TV · Als Nächstes: S1:F5 · Wrenfield Pier');
    });
  });

  it('minutesLeft: whole minutes up, null without a duration or at the end', () => {
    expect(minutesLeft({ position: 0, duration: 61 })).toBe(2);
    expect(minutesLeft({ position: 0, duration: 60 })).toBe(1);
    expect(minutesLeft({ position: 60, duration: 60 })).toBeNull();
    expect(minutesLeft({ position: 0, duration: 0 })).toBeNull();
  });

  it('line 1: the title; episodes add the code (from the item, else from the session subtitle)', () => {
    const ep = { ...base, title: 'Dunmoor', isEpisode: true, subtitle: 'S1:F4 The Lantern Road' };
    expect(barLine1({ ...base, title: 'Saltwater Almanac' }, null, tr)).toBe('Saltwater Almanac');
    expect(barLine1(ep, { parentIndexNumber: 1, indexNumber: 4 }, tr)).toBe('Dunmoor · S1:F4');
    expect(barLine1(ep, null, tr)).toBe('Dunmoor · S1:F4');
    expect(barLine1({ ...ep, subtitle: 'T1:E4 La Calle del Farol' }, null, tr)).toBe('Dunmoor · T1:E4');
    expect(barLine1({ ...ep, subtitle: 'The Lantern Road' }, null, tr)).toBe('Dunmoor');
    expect(barLine1({ ...ep, subtitle: '2 Fast 2 Furious' }, null, tr)).toBe('Dunmoor');
    expect(barLine1({ ...ep, subtitle: '' }, { indexNumber: 4 }, tr)).toBe('Dunmoor · F4');
  });

  it('the room the layout reserves', () => {
    expect(CASTBAR_H).toEqual({ desktop: 92, phone: 76 });
  });

  describe('expanded bar lines', () => {
    const ep = { ...base, title: 'Dunmoor', isEpisode: true, subtitle: 'S1:F4 The Lantern Road', kind: 'chromecast' as const, state: 'playing' as const, position: 600, duration: 2400 };
    it('line 1 adds the episode name', () => {
      expect(barTitleFull(ep, { name: 'The Lantern Road', parentIndexNumber: 1, indexNumber: 4 }, tr)).toBe('Dunmoor · S1:F4 · The Lantern Road');
      expect(barTitleFull(ep, null, tr)).toBe('Dunmoor · S1:F4 · The Lantern Road');
      expect(barTitleFull({ ...base, title: 'Saltwater Almanac' }, null, tr)).toBe('Saltwater Almanac');
    });
    it('line 2 names the upcoming episode while one plays; else the collapsed line', () => {
      const upcoming = { itemId: 'e5', label: 'S1:F5 · Wrenfield Pier' };
      expect(barLine2Full({ ...ep, upcoming }, 0, tr)).toEqual({ text: 'Auf Wohnzimmer-TV · Als Nächstes: S1:F5 · Wrenfield Pier', tone: 'none', device: 'Wohnzimmer-TV' });
      expect(barLine2Full(ep, 0, tr)).toEqual(barLine2(ep, 0, tr));
      expect(barLine2Full({ ...ep, upcoming, state: 'connecting' }, 0, tr).text).toBe('Verbinde mit Wohnzimmer-TV …');
    });
  });

  it('splitLine: the device name between its two ends, the countdown tail apart', () => {
    expect(splitLine({ text: 'Auf Wohnzimmer-TV · noch 29 Min.', tone: 'none', device: 'Wohnzimmer-TV' })).toEqual({ pre: 'Auf ', dev: 'Wohnzimmer-TV', post: ' · noch 29 Min.', tail: '' });
    expect(splitLine({ text: 'Auf TV · Als Nächstes: X · in 6 s', tone: 'none', device: 'TV', tail: ' · in 6 s' })).toEqual({ pre: 'Auf ', dev: 'TV', post: ' · Als Nächstes: X', tail: ' · in 6 s' });
    expect(splitLine({ text: 'Verbindung verloren', tone: 'warn' })).toBeNull();
  });
});

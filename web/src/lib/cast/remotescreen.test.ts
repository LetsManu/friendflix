// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { applePlatform, episodeCodeLine, nowLine, upNextLine, upNextOf, remoteLayout, scrubberTarget, segmentMarks, statusOf, timeLine, volumeLine } from './remotescreen';

const tf = tr;
const base = { kind: 'chromecast' as const, device: 'Wohnzimmer-TV' };

describe('remote screen: layout', () => {
  it('breakpoints: 1100 wide, 1099 stacked, 721 stacked, 720 phone', () => {
    expect(remoteLayout(1440)).toBe('wide');
    expect(remoteLayout(1100)).toBe('wide');
    expect(remoteLayout(1099)).toBe('stacked');
    expect(remoteLayout(721)).toBe('stacked');
    expect(remoteLayout(720)).toBe('phone');
    expect(remoteLayout(390)).toBe('phone');
  });
});

describe('remote screen: status', () => {
  it('connecting names the device', () => {
    expect(statusOf({ ...base, state: 'connecting' }, tf)).toEqual({ tone: 'none', text: 'Verbinde mit Wohnzimmer-TV …', action: null });
    expect(statusOf({ kind: 'airplay', device: 'AirPlay-Gerät', state: 'connecting' }, tf).text).toBe('Verbinde mit AirPlay …');
  });
  it('reconnect and detached: warning, Reconnect', () => {
    for (const state of ['reconnect', 'detached'] as const) expect(statusOf({ ...base, state }, tf)).toEqual({ tone: 'warn', text: 'Verbindung verloren', action: 'reconnect' });
  });
  it('failed: error, Play here', () => {
    expect(statusOf({ ...base, state: 'failed' }, tf)).toEqual({ tone: 'error', text: 'Konnte auf dem Fernseher nicht abspielen', action: 'playHere' });
  });
  it('playing and ended: nothing to say', () => {
    for (const state of ['playing', 'ended'] as const) expect(statusOf({ ...base, state }, tf)).toEqual({ tone: 'none', text: '', action: null });
  });
});

describe('remote screen: clock and volume', () => {
  it('timeLine: elapsed, minus remaining, spoken value', () => {
    expect(timeLine({ position: 65, duration: 2830 }, tf)).toEqual({ elapsed: '1:05', remaining: '\u221246:05', valueText: '1:05 von 47:10' });
    expect(timeLine({ position: 3700, duration: 3600 }, tf).remaining).toBe('−0:00'); // never negative
    expect(timeLine({ position: 0, duration: 0 }, tf).valueText).toBe('0:00 von 0:00');
  });
  it('volumeLine: AirPlay names the Apple device, Chromecast has a slider', () => {
    expect(volumeLine('airplay', 'iPhone', tf)).toBe('Lautstärke: Tasten am iPhone oder TV-Fernbedienung');
    expect(volumeLine('airplay', 'Mac', tf)).toBe('Lautstärke: Tasten am Mac oder TV-Fernbedienung');
    expect(volumeLine('airplay', null, tf)).toContain('iPhone');
    expect(volumeLine('chromecast', null, tf)).toBeNull();
  });
  it('applePlatform from the user agent', () => {
    expect(applePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(applePlatform('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(applePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('iPad'); // iPadOS in desktop mode
    expect(applePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('Mac');
    expect(applePlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBeNull();
  });
});

describe('remote screen: scrubber', () => {
  it('segmentMarks: intro 60–180 s of 2830 s', () => {
    const [m] = segmentMarks([{ type: 'intro', start: 60, end: 180 }], 2830);
    expect(m!.type).toBe('intro');
    expect(m!.left).toBeCloseTo(0.0212, 4);
    expect(m!.width).toBeCloseTo(120 / 2830, 6);
  });
  it('segmentMarks: only intro and recap, clamped, nothing without a duration', () => {
    expect(segmentMarks([{ type: 'outro', start: 10, end: 20 }, { type: 'recap', start: -5, end: 3000 }], 100)).toEqual([{ type: 'recap', left: 0, width: 1 }]);
    expect(segmentMarks([{ type: 'intro', start: 5, end: 5 }], 100)).toEqual([]);
    expect(segmentMarks([{ type: 'intro', start: 5, end: 9 }], 0)).toEqual([]);
  });
  it('scrubberTarget: arrows ±10 s, Page keys ±60 s, Home / End, clamped', () => {
    expect(scrubberTarget('ArrowRight', 100, 600)).toBe(110);
    expect(scrubberTarget('ArrowLeft', 4, 600)).toBe(0);
    expect(scrubberTarget('PageUp', 580, 600)).toBe(600);
    expect(scrubberTarget('PageDown', 100, 600)).toBe(40);
    expect(scrubberTarget('Home', 100, 600)).toBe(0);
    expect(scrubberTarget('End', 100, 600)).toBe(600);
    expect(scrubberTarget('a', 100, 600)).toBeNull();
  });
});

describe('remote screen: the line under the title', () => {
  const ep = { isEpisode: true, subtitle: 'The Lantern Road' };
  it('episode: season, episode and name; phone: short', () => {
    const it = { name: 'The Lantern Road', parentIndexNumber: 1, indexNumber: 4 };
    expect(nowLine(ep, it, tf)).toBe('Staffel 1 \u00b7 Folge 4 \u00b7 The Lantern Road');
    expect(nowLine(ep, it, tf, true)).toBe('S1:F4 \u00b7 The Lantern Road');
  });
  it('episode without numbers or item: the session subtitle', () => {
    expect(nowLine(ep, { name: 'X' }, tf)).toBe('The Lantern Road');
    expect(nowLine(ep, undefined, tf)).toBe('The Lantern Road');
  });
  it('film: year and runtime', () => {
    expect(nowLine({ isEpisode: false, subtitle: '' }, { name: 'F', year: 2023, runtimeTicks: 112 * 600_000_000 }, tf)).toBe('2023 \u00b7 1 Std. 52 Min.');
    expect(nowLine({ isEpisode: false, subtitle: '' }, { name: 'F' }, tf)).toBe('');
  });
});

describe('remote screen: up next', () => {
  const next = (startsAt: number | null) => ({ itemId: 'e5', label: 'S1:E5 \u00b7 Wrenfield Pier', startsAt });
  it('upNextLine: a running countdown', () => {
    expect(upNextLine({ kind: 'chromecast', autoplay: true, next: next(10_000) }, 3_500, tf)).toBe('Startet in 7 s');
    expect(upNextLine({ kind: 'chromecast', autoplay: false, next: next(5_000) }, 0, tf)).toBe('Startet in 5 s');
  });
  it('upNextLine: before the credits the switch decides', () => {
    expect(upNextLine({ kind: 'chromecast', autoplay: true, next: undefined }, 0, tf)).toBe('Startet von selbst auf dem Fernseher.');
    expect(upNextLine({ kind: 'chromecast', autoplay: false, next: undefined }, 0, tf)).toBe('Startet, wenn du es willst.');
  });
  it('upNextLine: a cancelled offer (button only) waits, whatever the switch says', () => {
    expect(upNextLine({ kind: 'chromecast', autoplay: true, next: next(null) }, 0, tf)).toBe('Startet, wenn du es willst.');
    expect(upNextLine({ kind: 'airplay', autoplay: true, next: next(null) }, 0, tf)).toBe('Startet, wenn du es willst.');
  });
  it('upNextLine: AirPlay adds the lock sentence where something starts by itself', () => {
    expect(upNextLine({ kind: 'airplay', autoplay: true, next: undefined }, 0, tf)).toBe('Startet von selbst auf dem Fernseher. Ist das iPhone gesperrt, startet sie beim Entsperren.');
    expect(upNextLine({ kind: 'airplay', autoplay: true, next: next(10_000) }, 0, tf)).toBe('Startet in 10 s. Ist das iPhone gesperrt, startet sie beim Entsperren.');
    expect(upNextLine({ kind: 'airplay', autoplay: false, next: undefined }, 0, tf)).toBe('Startet, wenn du es willst.');
  });
  it('upNextOf: the credits offer, else the upcoming episode while it plays; after the end only the offer; never films', () => {
    const n = next(null), up = { itemId: 'e5', label: 'L' };
    expect(upNextOf({ isEpisode: true, state: 'playing', next: n, upcoming: up })).toBe(n);
    expect(upNextOf({ isEpisode: true, state: 'playing', next: undefined, upcoming: up })).toEqual({ itemId: 'e5', label: 'L', startsAt: null });
    expect(upNextOf({ isEpisode: true, state: 'playing', next: undefined, upcoming: undefined })).toBeNull();
    expect(upNextOf({ isEpisode: true, state: 'ended', next: n, upcoming: up })).toBe(n);
    expect(upNextOf({ isEpisode: true, state: 'ended', next: undefined, upcoming: up })).toBeNull();
    expect(upNextOf({ isEpisode: false, state: 'playing', next: n, upcoming: up })).toBeNull();
    expect(upNextOf({ isEpisode: true, state: 'reconnect', next: n, upcoming: up })).toBeNull();
  });
});

describe('remote screen: episode code', () => {
  it('one format through i18n; the name alone without numbers', () => {
    expect(episodeCodeLine({ name: 'Wrenfield Pier', parentIndexNumber: 1, indexNumber: 5 }, tr)).toBe('S1:F5 \u00b7 Wrenfield Pier');
    expect(episodeCodeLine({ name: 'Wrenfield Pier' }, tr)).toBe('Wrenfield Pier');
  });
});

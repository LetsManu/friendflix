// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { dismiss, DISMISS_KEY, DISMISS_MAX, handoffAge, handoffDevice, handoffHref, handoffTime, handoffTitle, isDismissed, shouldTakeFocus, type Handoff } from './handoff';

const base: Handoff = {
  id: 'h1', itemId: 'e4', type: 'Episode', title: 'The Lantern Road', seriesName: 'Dunmoor', season: 1, episode: 4, imageId: 'e4',
  positionTicks: 13_900_000_000, runtimeTicks: 27_000_000_000, ageSec: 720, device: { kind: 'webos' },
};
const film: Handoff = { ...base, id: 'h2', itemId: 'f1', type: 'Movie', title: 'Harbor Lights', year: 2019, seriesName: undefined, season: undefined, episode: undefined };

/** a Storage in a Map */
const memory = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
};
const throwing = (): Storage => ({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); }, clear: () => {}, key: () => null, length: 0 }) as Storage;

describe('handoff helpers', () => {
  it('device line per kind, custom name and via', () => {
    expect(handoffDevice(base, tr)).toBe('LG-Fernseher');
    expect(handoffDevice({ ...base, device: { kind: 'tizen' } }, tr)).toBe('Samsung-Fernseher');
    expect(handoffDevice({ ...base, device: { kind: 'web', name: 'Safari auf iPhone' } }, tr)).toBe('Safari auf iPhone');
    expect(handoffDevice({ ...base, device: { kind: 'webos', name: 'Wohnzimmer' } }, tr)).toBe('Wohnzimmer');
    expect(handoffDevice({ ...base, device: { kind: 'web', name: 'Safari auf iPhone', via: 'airplay' } }, tr)).toBe('AirPlay (Safari auf iPhone)');
    expect(handoffDevice({ ...base, device: { kind: 'android', via: 'chromecast' } }, tr)).toBe('Chromecast (Android-App)');
  });

  it('dismissal keeps the last 20 and survives a throwing storage', () => {
    const s = memory();
    for (let i = 0; i < DISMISS_MAX + 5; i++) dismiss(`id${i}`, s);
    const kept = JSON.parse(s.getItem(DISMISS_KEY)!) as string[];
    expect(kept).toHaveLength(DISMISS_MAX);
    expect(isDismissed('id0', s)).toBe(false);
    expect(isDismissed(`id${DISMISS_MAX + 4}`, s)).toBe(true);
    dismiss('id24', s); // twice: still once
    expect((JSON.parse(s.getItem(DISMISS_KEY)!) as string[]).filter((x) => x === 'id24')).toHaveLength(1);
    // a broken value is no list
    s.setItem(DISMISS_KEY, '{oops');
    expect(isDismissed('x', s)).toBe(false);
    // storage that throws: the dismissal lasts in memory, nothing throws
    const t = throwing();
    expect(isDismissed('mem1', t)).toBe(false);
    expect(() => dismiss('mem1', t)).not.toThrow();
    expect(isDismissed('mem1', t)).toBe(true);
    expect(isDismissed('mem2', null)).toBe(false);
    dismiss('mem2', null);
    expect(isDismissed('mem2', null)).toBe(true);
  });

  it('time m:ss and h:mm:ss', () => {
    expect(handoffTime(13_900_000_000)).toBe('23:10');
    expect(handoffTime(37_250_000_000)).toBe('1:02:05');
  });

  it('age', () => {
    expect(handoffAge(90, tr, 0)).toBe('gerade eben');
    expect(handoffAge(119, tr, 0)).toBe('gerade eben');
    expect(handoffAge(720, tr, 1_000_000)).toBe('vor 12 Minuten');
  });

  it('title lines', () => {
    expect(handoffTitle(base, tr)).toBe('Dunmoor S1:F4 · The Lantern Road');
    expect(handoffTitle(film, tr)).toBe('Harbor Lights · 2019');
    expect(handoffTitle({ ...film, year: undefined }, tr)).toBe('Harbor Lights');
  });

  it('href', () => {
    expect(handoffHref(base)).toBe('/watch/e4?t=1390');
    expect(handoffHref({ ...base, positionTicks: 0 })).toBe('/watch/e4?t=0');
  });

  it('TV: the card takes focus only when it arrives within 2 s of mount and before any key', () => {
    expect(shouldTakeFocus({ mountedAt: 1000, arrivedAt: 2900, keyPressed: false })).toBe(true);
    expect(shouldTakeFocus({ mountedAt: 1000, arrivedAt: 3000, keyPressed: false })).toBe(true); // 2 s exactly still counts
    expect(shouldTakeFocus({ mountedAt: 1000, arrivedAt: 3100, keyPressed: false })).toBe(false);
    expect(shouldTakeFocus({ mountedAt: 1000, arrivedAt: 1500, keyPressed: true })).toBe(false);
    expect(shouldTakeFocus({ mountedAt: 1000, arrivedAt: 900, keyPressed: false })).toBe(false); // a clock that went back: no
  });
});

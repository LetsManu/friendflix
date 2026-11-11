// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { formFactor, playOnRows, whatLine } from './playOn';

const none = { chromecast: false, devices: false, airplay: false, apple: false, continuousAvailable: false, episode: true, last: null, casting: null, form: 'computer' as const, tf: tr };
const ids = (o: Partial<Parameters<typeof playOnRows>[0]>) => playOnRows({ ...none, ...o }).map((r) => r.id);

describe('playOnRows (spec §3)', () => {
  it('Chrome with devices and a remembered TV: last, another, here', () => {
    const rows = playOnRows({ ...none, chromecast: true, devices: true, last: 'Wohnzimmer-TV' });
    expect(rows.map((r) => r.id)).toEqual(['last', 'another', 'here']);
    expect(rows[0]).toMatchObject({ title: 'Wohnzimmer-TV', hint: 'Chromecast · zuletzt verwendet', checked: false });
    expect(rows[1]).toMatchObject({ title: 'Anderer Fernseher …', hint: 'Chromecast' });
  });
  it('Chrome with devices but no remembered TV: no last row', () => {
    expect(ids({ chromecast: true, devices: true })).toEqual(['another', 'here']);
  });
  it('Chrome without devices: no Chromecast rows', () => {
    expect(ids({ chromecast: true, devices: false, last: 'Wohnzimmer-TV' })).toEqual(['here']);
  });
  it('Safari with AirPlay: airplay, here', () => {
    const rows = playOnRows({ ...none, airplay: true, apple: true });
    expect(rows.map((r) => r.id)).toEqual(['airplay', 'here']);
    expect(rows[0]).toMatchObject({ title: 'AirPlay …', hint: 'Apple TV und AirPlay-Fernseher' });
  });
  it('nothing available: only this device, playing here', () => {
    const rows = playOnRows(none);
    expect(rows).toEqual([{ id: 'here', title: 'Dieser Computer', hint: 'Läuft gerade hier', checked: true }]);
  });
  it('this device is named after the form factor', () => {
    expect(playOnRows({ ...none, form: 'phone' })[0]!.title).toBe('Dieses Handy');
    expect(playOnRows({ ...none, form: 'tablet' })[0]!.title).toBe('Dieses Tablet');
  });
  it('casting Chromecast: here continues locally, the current TV row is checked', () => {
    const rows = playOnRows({ ...none, chromecast: true, devices: true, last: 'Wohnzimmer-TV', casting: 'chromecast' });
    expect(rows.find((r) => r.id === 'here')).toMatchObject({ title: 'Hier weiterschauen', checked: false });
    expect(rows.find((r) => r.id === 'last')!.checked).toBe(true);
    expect(rows.find((r) => r.id === 'another')!.checked).toBe(false);
  });
  it('casting AirPlay checks the AirPlay row', () => {
    const rows = playOnRows({ ...none, airplay: true, apple: true, casting: 'airplay' });
    expect(rows.find((r) => r.id === 'airplay')!.checked).toBe(true);
    expect(rows.find((r) => r.id === 'here')!.title).toBe('Hier weiterschauen');
  });
  it('continuous never shows while it is not available, nor for films, nor without AirPlay', () => {
    expect(ids({ airplay: true, apple: true, continuousAvailable: false })).not.toContain('continuous');
    expect(ids({ airplay: true, apple: true, continuousAvailable: true, episode: false })).not.toContain('continuous');
    expect(ids({ airplay: false, apple: true, continuousAvailable: true })).not.toContain('continuous');
    expect(ids({ airplay: true, apple: false, continuousAvailable: true })).not.toContain('continuous');
    expect(ids({ airplay: true, apple: true, continuousAvailable: true })).toEqual(['airplay', 'continuous', 'here']);
  });
});

describe('whatLine', () => {
  it('episode and film', () => {
    expect(whatLine({ title: 'Dunmoor', episode: 'S1 E4', at: 18 * 60 + 42, tf: tr })).toBe('Dunmoor · S1 E4 ab 18:42');
    expect(whatLine({ title: 'Saltwater Almanac', at: 3725, tf: tr })).toBe('Saltwater Almanac ab 1:02:05');
    expect(whatLine({ title: 'Saltwater Almanac', at: 0, tf: tr })).toBe('Saltwater Almanac ab 0:00');
  });
});

describe('formFactor', () => {
  const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints });
  it('phone, tablet, computer', () => {
    expect(formFactor(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5), 390)).toBe('phone');
    expect(formFactor(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 5), 412)).toBe('phone');
    expect(formFactor(nav('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5), 820)).toBe('tablet');
    expect(formFactor(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 1024)).toBe('tablet');
    expect(formFactor(nav('Mozilla/5.0 (Linux; Android 14; SM-X900) Safari', 5), 900)).toBe('tablet');
    expect(formFactor(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 1440)).toBe('computer');
    expect(formFactor(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0), 1440)).toBe('computer');
  });
  it('a narrow touchless window is still a computer', () => {
    expect(formFactor(nav('Mozilla/5.0 (X11; Linux x86_64)', 0), 390)).toBe('computer');
  });
});

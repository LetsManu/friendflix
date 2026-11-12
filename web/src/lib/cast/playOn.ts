// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The "Play on" sheet's rows and header line (spec §3). Pure: PlayOnSheet.svelte only draws what these return. */
import { fmtClock } from '#lib/api';
import type { TFn } from '#lib/i18n';
import type { CastKind } from './engine';

export type PlayOnRow = { id: 'last' | 'another' | 'airplay' | 'here'; title: string; hint: string; checked: boolean };

export type PlayOnInput = {
  /** a Chromium browser with the Cast SDK and the server's casting switch on */
  chromecast: boolean;
  /** the browser reports Cast devices in reach */
  devices: boolean;
  /** an AirPlay target is available (or the AirPlay route is already in use) */
  airplay: boolean;
  /** the TV used last time in this browser (name only) */
  last: string | null;
  casting: CastKind | null;
  form: 'phone' | 'tablet' | 'computer';
  tf: TFn;
};

/** rows in the spec's order; those that do not apply are left out. "This device" is always there. */
export function playOnRows(o: PlayOnInput): PlayOnRow[] {
  const rows: PlayOnRow[] = [];
  const cc = o.chromecast && o.devices;
  if (cc && o.last) rows.push({ id: 'last', title: o.last, hint: o.tf('player.castPicker.lastUsed'), checked: o.casting === 'chromecast' });
  if (cc) rows.push({ id: 'another', title: o.tf('player.castPicker.another'), hint: o.tf('player.castPicker.chromecast'), checked: false });
  if (o.airplay) rows.push({ id: 'airplay', title: o.tf('player.castPicker.airplay'), hint: o.tf('player.castPicker.airplayHint'), checked: o.casting === 'airplay' });
  const device = o.tf(o.form === 'phone' ? 'player.castPicker.thisPhone' : o.form === 'tablet' ? 'player.castPicker.thisTablet' : 'player.castPicker.thisComputer');
  rows.push(o.casting
    ? { id: 'here', title: o.tf('player.castPicker.continueHere'), hint: device, checked: false }
    : { id: 'here', title: device, hint: o.tf('player.castPicker.playingHere'), checked: true });
  return rows;
}

/** "Dunmoor · S1 E4 ab 18:42"; a film: "Title ab 18:42" */
export function whatLine(o: { title: string; episode?: string; at: number; tf: TFn }): string {
  const time = fmtClock(Math.max(0, Math.floor(o.at)));
  return o.episode ? o.tf('player.castPicker.what', { title: o.title, episode: o.episode, time }) : o.tf('player.castPicker.whatFilm', { title: o.title, time });
}

/** which kind of device this is, for the "This phone / tablet / computer" row (touch points tell an iPad in desktop mode apart from a Mac) */
export function formFactor(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>, width: number): 'phone' | 'tablet' | 'computer' {
  const ua = nav.userAgent, touch = nav.maxTouchPoints > 0;
  if (/iPhone|iPod/.test(ua)) return 'phone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'tablet';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'phone' : 'tablet';
  if (touch && width < 600) return 'phone';
  return 'computer';
}

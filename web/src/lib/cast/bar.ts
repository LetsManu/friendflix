// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { img } from '#lib/api';
import type { TFn } from '#lib/i18n';
import type { Item } from '#lib/api';
import type { CastSession } from './engine';
import { deviceLabel } from './remoteview';

/** the engine drives this session (a `detached` one is only known from the hint: no lock screen, no remote, taps play here) */
export const liveCast = (s: CastSession | null): s is CastSession => s !== null && s.state !== 'detached';

/** The cast bar shows while a title plays on a TV, except on the immersive pages (watch, party) and in TV mode. */
export function barVisible(o: { path: string; tv: boolean; session: CastSession | null }): boolean {
  return o.session !== null && !o.tv && !/^\/(watch|party)\//.test(o.path);
}

/** Second bar line: "subtitle · auf Gerät" (just "auf Gerät" for films). */
export function barLine(s: CastSession, tf: TFn): string {
  const on = tf('player.castBar.on', { device: s.device });
  return s.subtitle ? `${s.subtitle} · ${on}` : on;
}

/** Playback progress in percent (0–100); 0 while the duration is unknown. */
export function barProgress(s: CastSession): number {
  return s.duration > 0 ? Math.min(100, Math.max(0, (s.position / s.duration) * 100)) : 0;
}

/** Poster for the bar: landscape still for episodes, portrait poster for films. */
export function barThumb(s: CastSession): { src: string; ratio: '16/9' | '2/3' } {
  return { src: img(s.posterId, 160), ratio: s.isEpisode ? '16/9' : '2/3' };
}

/** Whole seconds until the next episode autoplays (rounded up, never negative); null without a countdown. */
export function nextSecondsLeft(startsAt: number | null, now: number): number | null {
  return startsAt === null ? null : Math.max(0, Math.ceil((startsAt - now) / 1000));
}

/** `--castbar-h` in px: the room the layout keeps free for the bar (its height plus the gap below it; spec §2) */
export const CASTBAR_H = { desktop: 92, phone: 76 } as const;

/** whole minutes left, rounded up (never "0 min" while something remains); null without a duration or at the end */
export function minutesLeft(s: Pick<CastSession, 'position' | 'duration'>): number | null {
  const left = s.duration - s.position;
  return s.duration > 0 && left > 0 ? Math.ceil(left / 60) : null;
}

/** episode code as the app writes it ("S1:E4", "E4" without a season), from the item; else the session subtitle's leading code */
function episodeCode(s: Pick<CastSession, 'subtitle'>, it: Pick<Item, 'parentIndexNumber' | 'indexNumber'> | null | undefined, tf: TFn): string {
  if (it && it.indexNumber != null) return it.parentIndexNumber != null ? tf('detail.view.episodeCode', { s: it.parentIndexNumber, e: it.indexNumber }) : tf('player.episodeOnly', { e: it.indexNumber });
  const lead = s.subtitle.split(' ')[0] ?? '';
  return /^S\d+:[A-Z]\d+$/.test(lead) ? lead : '';
}
/** first bar line: the title; an episode adds its code ("Dunmoor · S1:E4"; the episode's name lives in the expanded bar) */
export function barLine1(s: Pick<CastSession, 'title' | 'isEpisode' | 'subtitle'>, it: Pick<Item, 'parentIndexNumber' | 'indexNumber'> | null | undefined, tf: TFn): string {
  const code = s.isEpisode ? episodeCode(s, it, tf) : '';
  return code ? `${s.title} \u00b7 ${code}` : s.title;
}

export interface BarLine2 { text: string; tone: 'none' | 'warn' | 'error' }
/**
 * Second bar line, by state (spec §2 table): playing and paused "On {device} · {n} min left", the offered next episode, connecting,
 * connection lost (warn), could not play (error). `choose`: AirPlay waits for the TV to be picked in the system list.
 */
export function barLine2(s: CastSession, now: number, tf: TFn, o: { choose?: boolean } = {}): BarLine2 {
  const device = s.device || deviceLabel(s);
  switch (s.state) {
    case 'connecting': return { text: tf('player.castRemote.connecting', { device: deviceLabel(s) }), tone: 'none' };
    case 'reconnect':
    case 'detached': return o.choose ? { text: tf('player.airplay.chooseHint'), tone: 'none' } : { text: tf('player.castRemote.lost'), tone: 'warn' };
    case 'failed': return { text: tf('player.castRemote.cannotPlay'), tone: 'error' };
    default: {
      if (s.next) {
        const secs = nextSecondsLeft(s.next.startsAt, now);
        const line = tf('player.castBar.upNextLine', { device, label: s.next.label });
        return { text: secs !== null ? `${line} \u00b7 ${tf('player.castBar.nextIn', { n: secs })}` : line, tone: 'none' };
      }
      const n = minutesLeft(s);
      return { text: n === null ? tf('player.castBar.playingOn', { device }) : tf('player.castBar.onLeft', { device, n }), tone: 'none' };
    }
  }
}

/** expanded bar, first line: "Dunmoor · S1:E4 · The Lantern Road" (a film: its title) */
export function barTitleFull(s: Pick<CastSession, 'title' | 'isEpisode' | 'subtitle'>, it: Pick<Item, 'name' | 'parentIndexNumber' | 'indexNumber'> | null | undefined, tf: TFn): string {
  if (!s.isEpisode) return s.title;
  const head = barLine1(s, it, tf);
  const name = it?.name ?? s.subtitle.replace(/^\S*\d\S*\s+/, '');
  return name && name !== s.title ? `${head} · ${name}` : head;
}

/** expanded bar, second line: as `barLine2`, and while an episode plays the one that follows ("On {device} · Up next: E5 · Wrenfield Pier") */
export function barLine2Full(s: CastSession, now: number, tf: TFn, o: { choose?: boolean } = {}): BarLine2 {
  if (s.state === 'playing' && !s.next && s.upcoming) return { text: tf('player.castBar.upNextLine', { device: s.device || deviceLabel(s), label: s.upcoming.label }), tone: 'none' };
  return barLine2(s, now, tf, o);
}

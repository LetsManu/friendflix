// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The remote screen's pure parts (layout breakpoints, status line, clock lines, volume hint, segment marks, up-next line).
 * The component only renders what these return.
 */
import { fmtClock, type Item } from '#lib/api';
import { fmtRuntime } from '#lib/hover';
import type { TFn } from '#lib/i18n';
import type { Segment } from '#lib/player/nextup';
import { nextSecondsLeft } from './bar';
import type { CastKind, CastSession } from './engine';
import { episodeOf, episodeRange } from './joined';
import { deviceLabel } from './remoteview';

/** ≥ 1100 px: now-playing and up-next side by side; 721–1099: up-next under the now-playing panel; ≤ 720: the phone layout */
export type RemoteLayout = 'wide' | 'stacked' | 'phone';
export const remoteLayout = (width: number): RemoteLayout => (width >= 1100 ? 'wide' : width > 720 ? 'stacked' : 'phone');

export interface RemoteStatus {
  tone: 'none' | 'warn' | 'error';
  text: string;
  /** `reconnect`: the engine's reconnect (inside the tap); `playHere`: drop the session, the title plays on this page */
  action: 'reconnect' | 'playHere' | null;
}

/** the one status line of the screen (spec §1, states table); nothing to say while the TV plays or after it finished */
export function statusOf(s: Pick<CastSession, 'state' | 'kind' | 'device'>, tf: TFn): RemoteStatus {
  switch (s.state) {
    case 'connecting': return { tone: 'none', text: tf('player.castRemote.connecting', { device: deviceLabel(s) }), action: null };
    case 'reconnect':
    case 'detached': return { tone: 'warn', text: tf('player.castRemote.lost'), action: 'reconnect' };
    case 'failed': return { tone: 'error', text: tf('player.castRemote.cannotPlay'), action: 'playHere' };
    default: return { tone: 'none', text: '', action: null };
  }
}

export interface TimeLine { elapsed: string; remaining: string; valueText: string }
/** elapsed on the left, "−remaining" on the right, and the slider's spoken value */
export function timeLine(s: Pick<CastSession, 'position' | 'duration'>, tf: TFn): TimeLine {
  const pos = Math.max(0, s.position), dur = Math.max(0, s.duration);
  const elapsed = fmtClock(pos);
  return { elapsed, remaining: `−${fmtClock(Math.max(0, dur - pos))}`, valueText: tf('player.valueText', { a: elapsed, b: fmtClock(dur) }) };
}

export type ApplePlatform = 'iPhone' | 'iPad' | 'Mac';
/** the Apple device the AirPlay sender runs on (its own buttons are the volume control); null when it cannot be told */
export function applePlatform(ua: string, touchPoints = 0): ApplePlatform | null {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  return null;
}

/** AirPlay has no volume control, only this line; Chromecast has the slider (null) */
export function volumeLine(kind: CastKind, platform: ApplePlatform | null, tf: TFn): string | null {
  return kind === 'airplay' ? tf('player.castRemote.volumeAirplay', { device: platform ?? 'iPhone' }) : null;
}

export interface SegmentMark { type: 'intro' | 'recap'; left: number; width: number }
/** intro / recap on the scrubber's track as fractions (0–1) of the duration */
export function segmentMarks(segs: Segment[], duration: number): SegmentMark[] {
  if (!(duration > 0)) return [];
  const out: SegmentMark[] = [];
  for (const x of segs) {
    if (x.type !== 'intro' && x.type !== 'recap') continue;
    const a = Math.min(1, Math.max(0, x.start / duration)), b = Math.min(1, Math.max(0, x.end / duration));
    if (b > a) out.push({ type: x.type, left: a, width: b - a });
  }
  return out;
}

/** the key's seek on the scrubber (←/→ ±10 s, PageUp/PageDown ±60 s, Home/End), clamped to the media; null: not a seek key */
export function scrubberTarget(key: string, position: number, duration: number): number | null {
  const by = (d: number) => Math.min(Math.max(0, duration), Math.max(0, position + d));
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return by(10);
    case 'ArrowLeft': case 'ArrowDown': return by(-10);
    case 'PageUp': return by(60);
    case 'PageDown': return by(-60);
    case 'Home': return 0;
    case 'End': return Math.max(0, duration);
    default: return null;
  }
}

/**
 * The line under the title: "Staffel 1 · Folge 4 · Name" (phone: "S1 · E4 · Name"); films: "year · runtime". Without the item
 * (not cached) the session's own subtitle.
 */
export function nowLine(s: Pick<CastSession, 'isEpisode' | 'subtitle'>, it: Pick<Item, 'name' | 'year' | 'runtimeTicks' | 'parentIndexNumber' | 'indexNumber'> | null | undefined, tf: TFn, short = false): string {
  if (!it) return s.subtitle;
  if (s.isEpisode) {
    if (it.parentIndexNumber == null || it.indexNumber == null) return s.subtitle || it.name;
    return short ? tf('player.phone.episodeLine', { s: it.parentIndexNumber, e: it.indexNumber, name: it.name }) : `${tf('home.new.seasonEpisode', { s: it.parentIndexNumber, e: it.indexNumber })} \u00b7 ${it.name}`;
  }
  return [it.year ? String(it.year) : '', fmtRuntime(it.runtimeTicks)].filter(Boolean).join(' \u00b7 ') || s.subtitle;
}

/**
 * The offer the up-next card shows (episodes only): the credits' offer (`next`, with or without a countdown) while the TV plays or
 * after the end, and before the credits the engine's `upcoming` (no countdown yet).
 */
export function upNextOf(s: Pick<CastSession, 'isEpisode' | 'state' | 'next' | 'upcoming'>): NonNullable<CastSession['next']> | null {
  if (!s.isEpisode) return null;
  if (s.state === 'ended') return s.next ?? null;
  if (s.state !== 'playing') return null;
  return s.next ?? (s.upcoming ? { ...s.upcoming, startsAt: null } : null);
}

/**
 * The card's status line. Before the credits (`upcoming` only): "Starts by itself" with autoplay on, else "Plays when you choose".
 * From the credits on: the countdown while it runs, else (cancelled, "still there?", autoplay off) "Plays when you choose". AirPlay
 * adds the honest limit as a second sentence where something starts by itself (if the iPhone locks, it starts at unlock).
 */
export function upNextLine(s: Pick<CastSession, 'kind' | 'autoplay' | 'next'>, now: number, tf: TFn): string {
  const secs = s.next ? nextSecondsLeft(s.next.startsAt, now) : null;
  const byItself = secs !== null || (!s.next && s.autoplay);
  const first = secs !== null ? tf('player.castRemote.startsIn', { n: secs }) : tf(byItself ? 'player.castRemote.startsBySelf' : 'player.castRemote.waits');
  if (s.kind !== 'airplay' || !byItself) return first;
  return `${first.endsWith('.') ? first : `${first}.`} ${tf('player.castRemote.onUnlock')}`;
}

/** an episode's code line in the app's language ("S1:F5 · Name", "S1:E5 · Name"); the name alone without numbers */
export function episodeCodeLine(it: Pick<Item, 'name' | 'parentIndexNumber' | 'indexNumber'>, tf: TFn): string {
  return it.parentIndexNumber != null && it.indexNumber != null ? tf('player.phone.episodeLine', { s: it.parentIndexNumber, e: it.indexNumber, name: it.name }) : it.name;
}

export interface ContinuousView {
  /** the info card's sentence */
  info: string;
  /** "Folge 1 von 3" */
  line: string;
  /** the plain rows of "Am St\u00fcck": the episode's code and name, "Jetzt" on the one the TV is in, else its length */
  list: Array<{ label: string; note: string; now: boolean }>;
  prevDisabled: boolean;
  nextDisabled: boolean;
}
/** the remote screen's continuous mode (a joined stream, spec cast \u00a71); null for a plain session */
export function continuousView(s: CastSession, tf: TFn): ContinuousView | null {
  const j = s.joined;
  if (!j || !j.items.length) return null;
  const first = j.items[0]!, last = j.items.at(-1)!;
  return {
    info: tf('player.castRemote.continuousInfo', { a: first.episode ?? 1, b: last.episode ?? j.items.length }),
    line: tf('player.castRemote.episodeOf', { n: j.index + 1, m: j.items.length }),
    list: j.items.map((it, i) => ({ label: episodeOf(s.title, it).sub, note: i === j.index ? tf('player.castRemote.now') : tf('player.castRemote.minutes', { n: Math.round(it.duration / 60) }), now: i === j.index })),
    prevDisabled: j.index <= 0,
    nextDisabled: j.index >= j.items.length - 1,
  };
}

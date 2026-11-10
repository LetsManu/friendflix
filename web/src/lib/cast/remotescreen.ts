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
    return `${short ? `S${it.parentIndexNumber} \u00b7 E${it.indexNumber}` : tf('home.new.seasonEpisode', { s: it.parentIndexNumber, e: it.indexNumber })} \u00b7 ${it.name}`;
  }
  return [it.year ? String(it.year) : '', fmtRuntime(it.runtimeTicks)].filter(Boolean).join(' \u00b7 ') || s.subtitle;
}

/** the offer the up-next card shows: an episode's next one, from the credits on (playing) or after the end; never for films */
export function upNextOf(s: Pick<CastSession, 'isEpisode' | 'state' | 'next'>): NonNullable<CastSession['next']> | null {
  return s.isEpisode && (s.state === 'playing' || s.state === 'ended') ? s.next ?? null : null;
}

/**
 * The card's status line: a running countdown, else "Starts by itself" (autoplay on) or "Plays when you choose". AirPlay adds the
 * honest limit as a second sentence (if the iPhone locks, it starts at unlock; true whenever continuous play is off).
 */
export function upNextLine(s: Pick<CastSession, 'kind' | 'autoplay' | 'next'>, now: number, tf: TFn): string {
  const secs = s.next ? nextSecondsLeft(s.next.startsAt, now) : null;
  const first = secs !== null ? tf('player.castRemote.startsIn', { n: secs }) : tf(s.autoplay ? 'player.castRemote.startsBySelf' : 'player.castRemote.waits');
  if (s.kind !== 'airplay') return first;
  return `${first.endsWith('.') ? first : `${first}.`} ${tf('player.castRemote.onUnlock')}`;
}

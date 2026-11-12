// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Continuous AirPlay (spec device-handoff §5): one token stream carries several episodes back to back. Its `joined.items` give each
 * episode's place on the stream's timeline (stream seconds; the first episode starts at 0). The element (and the TV) play stream
 * seconds; everything shown or asked per episode (the remote screen, a hand-back to the phone, a new token) goes through these.
 */
import { ticksToSec } from '#lib/api';
import type { JoinedInfo } from '#lib/cast';
import type { TFn } from '#lib/i18n';
import { barTitles } from '#lib/player/bar';

export type JoinedItem = JoinedInfo['items'][number];

/** stream second `pos` as (episode index, offset in it); exactly on a boundary: the later episode; past the end: the last one's end */
export function joinedAt(items: JoinedInfo['items'], pos: number): { index: number; offset: number } {
  const p = Number.isFinite(pos) ? Math.max(0, pos) : 0;
  let index = 0;
  for (let i = 1; i < items.length; i++) if (p >= items[i]!.start) index = i;
  const it = items[index];
  return it ? { index, offset: Math.min(p - it.start, it.duration) } : { index: 0, offset: p };
}

/** the whole stream's length in seconds: the last episode's end (else the token's runtime, which the server sets to the joined total) */
export function joinedLength(items: JoinedInfo['items'], runtimeTicks?: number): number {
  const last = items.at(-1);
  return last ? last.start + last.duration : runtimeTicks ? ticksToSec(runtimeTicks) : 0;
}

/**
 * What a new token for a joined stream asks for at stream second `pos` (spec §5.4 f): the episode the TV is in and the offset in
 * it (the new stream starts with that episode), and how many episodes this stream has left from there (that one included).
 */
export function joinedAsk(items: JoinedInfo['items'], pos: number): { itemId: string; offset: number; left: number } {
  const { index, offset } = joinedAt(items, pos);
  return { itemId: items[index]?.itemId ?? '', offset, left: Math.max(1, items.length - index) };
}

/** the bar's lines for an episode of the stream: the series name, then "S1:E2 Name" (the name alone without numbers) */
export function episodeOf(series: string, it: JoinedItem): { title: string; sub: string } {
  return barTitles({ name: it.title, seriesName: series, indexNumber: it.episode, parentIndexNumber: it.season });
}

/**
 * The episodes a joined stream carries as one label: "S2:F1\u2013F3" within a season, "S1:F9\u2013S2:F1" across seasons; without season
 * numbers "F1\u2013F3"; without episode numbers the first and last positions in the stream.
 */
export function episodeRange(items: JoinedInfo['items'], tf: TFn): string {
  const a = items[0], b = items.at(-1);
  if (!a || !b) return '';
  const ea = a.episode ?? 1, eb = b.episode ?? items.length;
  if (a.season == null || b.season == null) return `${tf('player.episodeOnly', { e: ea })}\u2013${tf('player.episodeOnly', { e: eb })}`;
  if (a.season === b.season) return tf('player.castRemote.episodeRange', { s: a.season, a: ea, b: eb });
  return `${tf('detail.view.episodeCode', { s: a.season, e: ea })}\u2013${tf('detail.view.episodeCode', { s: b.season, e: eb })}`;
}

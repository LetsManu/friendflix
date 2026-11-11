// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The body of the web player's POST /api/playback/{start,progress,stop} (Player.svelte `send`). While Safari's AirPlay token is armed
 * the token's play session is reported; `via: 'airplay'` only while the TV really plays it (`airOn`): in the arm window the phone
 * itself plays the token stream (lib/player/airplay.ts), and that is local playback for the device hand-off.
 */
import { secToTicks } from '#lib/api';

export interface PlayIds { playSessionId: string; mediaSourceId: string }
export interface PlayerReportBody extends PlayIds {
  itemId: string; positionTicks: number; isPaused: boolean; audioIndex?: number; playMethod: 'DirectPlay' | 'Transcode'; via?: 'airplay';
}

/** `position` in seconds; `local` = the player's own play session (/api/playback/info), `air` = the armed AirPlay token's */
export function playerReportBody(o: {
  itemId: string; local: PlayIds; air: PlayIds | null; airOn: boolean; position: number; paused: boolean; audioIndex?: number; direct: boolean;
}): PlayerReportBody {
  const ids = o.air ?? o.local;
  return {
    itemId: o.itemId, playSessionId: ids.playSessionId, mediaSourceId: ids.mediaSourceId, positionTicks: secToTicks(o.position), isPaused: o.paused,
    audioIndex: o.audioIndex, playMethod: !o.air && o.direct ? 'DirectPlay' : 'Transcode',
    ...(o.air && o.airOn ? { via: 'airplay' as const } : {}),
  };
}

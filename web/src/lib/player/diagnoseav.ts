// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The rows of /diagnose "Picture and sound" (Task 4 of the HEVC & surround plan): what this device plays (devicecaps summary), what the
 * server offers (the coarse /api/playback/abilities answer) and what the last playback was given and why (the last stored timing).
 * Pure: strings come from the translator and the fixed codes only; nothing here can show a URL, an id or a title.
 */
import { formatDelivery, safeCodec, whyList, type StoredTiming } from './timing';

export interface CapsFacts { hevcFiles: boolean; hevcStreams: boolean; surround: string[]; channels: number; stereoChoice: boolean; soundMode: boolean; avoided: { hevc?: number; surround?: number } }
export interface Abilities { hevc: 'ready' | 'off' | 'unproven' | 'unhealthy'; surround: boolean }
type Tr = (key: any, params?: any) => string;

const CODEC_NAME: Record<string, string> = { eac3: 'diagnose.codec.eac3', ac3: 'diagnose.codec.ac3', aac: 'diagnose.codec.aac' };

export function avRows(o: { caps: CapsFacts; abilities: Abilities | null; last: StoredTiming | null; t: Tr; date: (ms: number) => string }): Array<[string, string]> {
  const { caps, abilities, last, t, date } = o;
  const hevc = caps.avoided.hevc ? t('diagnose.hevcAvoided', { date: date(caps.avoided.hevc) })
    : caps.hevcFiles && caps.hevcStreams ? t('diagnose.hevcBoth') : caps.hevcFiles ? t('diagnose.hevcFiles') : caps.hevcStreams ? t('diagnose.hevcStreams') : t('diagnose.hevcNone');
  const surround = caps.channels >= 6 && caps.surround.length > 0;
  const sound = !surround ? t('diagnose.soundStereo')
    : caps.avoided.surround ? t('diagnose.soundAvoided', { date: date(caps.avoided.surround) })
    : caps.stereoChoice ? t('diagnose.soundChoice')
    : caps.soundMode ? t('diagnose.soundMode')
    : t('diagnose.soundSurround', { codecs: caps.surround.map((c) => (CODEC_NAME[c] ? t(CODEC_NAME[c]!) : c.toUpperCase())).join(', ') });
  const server = abilities
    ? `${t(`diagnose.serverHevc${{ ready: 'Ready', off: 'Off', unproven: 'Unproven', unhealthy: 'Unhealthy' }[abilities.hevc] ?? 'Off'}`)} · ${t(abilities.surround ? 'diagnose.serverSurroundOn' : 'diagnose.serverSurroundOff')}`
    : t('diagnose.serverUnknown');
  // a stored report with unknown codes (Plex, an older report, a start left early) is still a playback: "not known", never "no playback"
  const d = last ? formatDelivery({ videoOut: last.videoOut ?? null, audioOut: last.audioOut ?? null, ...(safeCodec(last.audioCodec) ? { audioCodec: safeCodec(last.audioCodec)! } : {}), ...(last.channels ? { channels: last.channels } : {}) }, t) : null;
  const why = last ? whyList(last.why).map((c) => t(`diagnose.why.${c}`)).join(' · ') : '';
  return [
    [t('diagnose.avRowHevc'), hevc],
    [t('diagnose.avRowSound'), sound],
    [t('diagnose.avRowServer'), server],
    [t('diagnose.avRowLast'), d ? t('diagnose.lastLine', { picture: d.picture, sound: d.sound }) : t('diagnose.lastNone')],
    [t('diagnose.avRowWhy'), why || t('diagnose.whyNone')],
  ];
}

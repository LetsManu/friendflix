// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The stream plan: a pure function from (device claim, source facts, caps, settings) to the HLS URL parameters Jellyfin gets and the
 * `delivery` block the player and Diagnose show. No I/O: the server's HEVC conversion gate (hevcenc.ts, Task 2) is asked by the caller
 * only when `wantsHevcEncode` is true and its answer applied with applyGate().
 *
 * Jellyfin 10.10 facts (read in the upstream source, release-10.10.z; Task 1 Step 0):
 *  - Codec-specific parameters are `<codec>-<name>` query parameters (BaseEncodingJobOptions.GetOption(codec, name), which falls back to the
 *    unqualified `<name>`): `hevc-codectag`, `hevc-profile`, `hevc-rangetype`, `h264-level`, `h264-videobitdepth` all exist. Lists are split on
 *    `,` and `|` (EncodingJobInfo.GetRequestedProfiles / GetRequestedRangeTypes / GetRequestedCodecTags).
 *  - CanStreamCopyVideo compares the source profile with spaces removed ("Main 10" -> "main10", so `hevc-profile=main,main10`), and a lower
 *    profile passes when a higher one is requested. A requested rangetype list refuses an Unknown source range; DOVIWithSDR passes for SDR.
 *    The source must have a video bitrate (stream BitRate) not above `VideoBitrate`, height within MaxHeight and MaxWidth. The codec tag is
 *    not part of the copy decision.
 *  - hvc1: DynamicHlsController writes `-tag:v:0 hvc1` whenever the actual output codec is HEVC (copied or encoded) and the source is not
 *    Dolby Vision that the client claimed. So fMP4 HEVC copy carries hvc1 whatever the source tag was.
 *  - CanStreamCopyAudio refuses a copy when the source track bitrate is above `AudioBitrate` (and when channels exceed the requested maximum).
 *    That is why a predicted audio copy sends max(budget, source track bitrate) as AudioBitrate.
 *  - `enableAdaptiveBitrateStreaming` exists on the master playlist endpoint (default true).
 */
import type { CapRange, ClientCaps } from './clientCaps.js';
import { maxWidthFor } from './types.js';

export type VideoOut = 'copy' | 'h264' | 'hevc';
export type AudioOut = 'copy' | 'stereo' | 'surround';
export type PlanWhy = 'hevc_device' | 'hevc_upload' | 'h264_device' | 'h264_home' | 'h264_hdr' | 'h264_off' | 'h264_unproven' | 'h264_unhealthy' | 'h264_busy'
  | 'surround_device' | 'stereo_device' | 'stereo_bitrate' | 'stereo_off' | 'stereo_source';
export type HevcGate = { ok: true } | { ok: false; why: 'h264_off' | 'h264_unproven' | 'h264_unhealthy' | 'h264_busy' };
export interface SourceFacts { videoCodec: string; videoBitrate?: number; height: number; /** absent = not checked; 0 = unknown (the server refuses a copy then) */ width?: number; range: string; profile?: string; audio?: { codec: string; channels: number; bitrate?: number } }
export interface PlanInput { caps: ClientCaps | null; cast: boolean; remote: boolean; maxBitrate: number; boxHeight: number; src: SourceFacts; surroundOn: boolean; hevcStreams: number }
export interface StreamDelivery { video: VideoOut; videoCodec: 'h264' | 'hevc'; audio: AudioOut; audioCodec: string; channels: number; why: PlanWhy[] }
export interface StreamPlan {
  segment: 'ts' | 'mp4'; videoCodecs: Array<'h264' | 'hevc'>; codecParams: Record<string, string>;
  audioCodecs: string[]; audioChannels: 2 | 6; audioBitrate: number; /** the VideoBitrate parameter: max(300 kbit/s, cap - audioBitrate) */ videoBitrate: number; wantsHevcEncode: boolean;
  /** the container the plan needs whatever the gate says (HEVC copy or surround); applyGate falls back to it when an encode is refused */
  keepMp4: boolean;
  delivery: StreamDelivery;
}

export const SURROUND_MIN_BPS = 4_000_000;
export const SURROUND_BUDGET = { eac3: 640_000, ac3: 640_000, aac: 384_000 } as const;
export const AUDIO_BITRATE = 192_000;
export const MIN_VIDEO_BITRATE = 300_000;
const SURROUND_ORDER = ['eac3', 'ac3', 'aac'] as const;

/** Jellyfin VideoRangeType values a stated range covers (a Dolby Vision file with a fallback layer plays as that layer) */
export const RANGE_TYPES: Record<CapRange, string[]> = {
  sdr: ['SDR', 'DOVIWithSDR'], hdr10: ['HDR10', 'DOVIWithHDR10'], hlg: ['HLG', 'DOVIWithHLG'], hdr10plus: ['HDR10Plus', 'DOVIWithHDR10Plus'],
  dovi: ['DOVI', 'DOVIWithSDR', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithHDR10Plus'],
};
export const jellyfinRanges = (ranges: CapRange[]): string => [...new Set(ranges.flatMap((r) => RANGE_TYPES[r]))].join('|');

/** the resolution box a bitrate cap and the role's height cap give (the HLS MaxHeight) */
export const boxHeightFor = (maxBitrate: number, maxHeight?: number | null): number => {
  const rung = maxBitrate >= 8e6 ? 1080 : maxBitrate >= 4e6 ? 720 : maxBitrate >= 1.5e6 ? 480 : 360;
  return maxHeight ? Math.min(rung, maxHeight) : rung;
};

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const PROFILE_RANK: Record<string, number> = { main: 1, main10: 2 };

export function planStream(i: PlanInput): StreamPlan {
  const hls = i.caps?.hls;
  const a = i.src.audio;

  // ---- audio (spec decisions 6-7)
  const surroundList = SURROUND_ORDER.filter((c) => hls?.surround.includes(c));
  const capable = Boolean(hls && surroundList.length && (i.caps?.audioChannels ?? 2) >= 6);
  let audioWhy: PlanWhy = 'stereo_device';
  let surround = false;
  if (capable) {
    if (!i.surroundOn) audioWhy = 'stereo_off';
    else if (i.maxBitrate < SURROUND_MIN_BPS) audioWhy = 'stereo_bitrate';
    else if (!a || a.channels <= 2) audioWhy = 'stereo_source';
    else { surround = true; audioWhy = 'surround_device'; }
  }
  let audioCodecs: string[];
  let audioBitrate = AUDIO_BITRATE;
  let audio: StreamDelivery['audio'];
  let audioCodec: string;
  let channels: number;
  /** the stereo branch's decision for the current `audioCodecs`: a source already in a listed codec at stereo and a fitting bitrate is copied */
  const stereoAudio = () => {
    const srcCodec = a?.codec.toLowerCase() ?? '';
    const copy = Boolean(a) && a!.channels <= 2 && audioCodecs.includes(srcCodec) && (a!.bitrate === undefined || a!.bitrate <= audioBitrate);
    return { audio: (copy ? 'copy' : 'stereo') as StreamDelivery['audio'], audioCodec: copy ? srcCodec : 'aac', channels: copy ? a!.channels : 2 };
  };
  if (surround && a) {
    audioCodecs = [...surroundList];
    const srcCodec = a.codec.toLowerCase();
    const copy = (surroundList as string[]).includes(srcCodec) && a.channels <= 6;
    // Jellyfin (ShiftAudioCodecsIfNeeded) moves ac3 / eac3 behind the others when the source has fewer than 6 channels and the list holds another codec
    const encodes = a.channels < 6 ? surroundList.filter((c) => c !== 'ac3' && c !== 'eac3') : [];
    const codec = copy ? srcCodec : (encodes[0] ?? surroundList[0]!);
    audioBitrate = Math.max(SURROUND_BUDGET[codec as keyof typeof SURROUND_BUDGET], copy ? a.bitrate ?? 0 : 0);
    audio = copy ? 'copy' : 'surround'; audioCodec = codec; channels = copy ? a.channels : 6;
  } else {
    audioCodecs = hls ? ['aac', ...(!i.cast && hls.audio.includes('mp3') ? ['mp3'] : [])] : i.cast ? ['aac'] : ['aac', 'mp3'];
    ({ audio, audioCodec, channels } = stereoAudio());
  }

  // ---- video
  const budget = Math.max(MIN_VIDEO_BITRATE, i.maxBitrate - audioBitrate);
  // Jellyfin writes hvc1 for every HEVC output, whatever `hevc-codectag` says: a device whose hevc entry names tags without hvc1 gets no HEVC stream
  const hevcTags = i.caps?.video.find((v) => v.codec === 'hevc')?.tags;
  const hevcOk = Boolean(hls?.video.includes('hevc')) && (!hevcTags || hevcTags.includes('hvc1'));
  const srcCodec = i.src.videoCodec.toLowerCase();
  const entry = i.caps?.video.find((v) => v.codec === srcCodec);
  // Dolby Vision (profile 5 and the like) stays direct play: an HLS remux would carry dvh1, which the hls claim never stated.
  // DOVIWithHDR10 / HLG / SDR still copy through Jellyfin's compatibility rule as plain hvc1.
  const ranges = (i.caps?.ranges ?? (['sdr'] as CapRange[])).filter((r) => r !== 'dovi');
  const rangeSet = new Set(jellyfinRanges(ranges).split('|').map((r) => r.toLowerCase()));
  const claimedProfiles = (i.caps?.video.find((v) => v.codec === 'hevc')?.profiles ?? []).map(squash);
  const profiles = claimedProfiles.length ? claimedProfiles : ['main'];
  const srcProfile = i.src.profile ? squash(i.src.profile) : '';
  const profileOk = srcCodec !== 'hevc' || !srcProfile || profiles.includes(srcProfile)
    || (PROFILE_RANK[srcProfile] !== undefined && PROFILE_RANK[srcProfile]! <= Math.max(0, ...profiles.map((p) => PROFILE_RANK[p] ?? 0)));
  const codecOk = srcCodec === 'h264' || (srcCodec === 'hevc' && hevcOk);
  const rangeOk = !hls || rangeSet.has(i.src.range.toLowerCase());
  const widthOk = i.src.width === undefined || (i.src.width > 0 && i.src.width <= maxWidthFor(i.boxHeight)); // the server refuses a copy wider than the box
  const heightOk = widthOk && i.src.height > 0 && i.src.height <= i.boxHeight && (!entry?.maxHeight || i.src.height <= entry.maxHeight);
  const exceeds = i.src.videoBitrate !== undefined && i.src.videoBitrate > budget;
  const fits = i.src.videoBitrate !== undefined && !exceeds;
  const copyVideo = codecOk && profileOk && rangeOk && heightOk && fits;
  const wantsHevcEncode = hevcOk && i.remote && i.hevcStreams > 0 && !copyVideo && exceeds && i.src.range === 'SDR';

  const videoCodecs: StreamPlan['videoCodecs'] = hevcOk && (srcCodec === 'hevc' || wantsHevcEncode) ? ['h264', 'hevc'] : ['h264'];
  const codecParams: Record<string, string> = {};
  if (videoCodecs.includes('hevc')) {
    const tags = (i.caps?.video.find((v) => v.codec === 'hevc')?.tags ?? []).filter((t) => t === 'hvc1' || t === 'hev1');
    codecParams['hevc-codectag'] = (tags.length ? tags : ['hvc1']).join(',');
    codecParams['hevc-profile'] = profiles.join(',');
    codecParams['hevc-rangetype'] = jellyfinRanges(ranges);
    // the cast receiver was probed for HEVC Level 4.1 (web/static/cast-receiver/logic.js): a source tagged higher is not copied to it (Jellyfin level = 30 x level)
    if (i.cast) codecParams['hevc-level'] = '123';
  }

  let video: VideoOut = 'h264';
  let videoWhy: PlanWhy[]; // every branch below assigns
  if (copyVideo) {
    video = 'copy';
    videoWhy = srcCodec === 'hevc' ? ['hevc_device'] : [];
  } else if (wantsHevcEncode) {
    videoWhy = ['h264_unproven']; // until the gate answers: never claim before a probe
  } else if (!hevcOk) videoWhy = ['h264_device'];
  else if (i.src.range === 'Unknown') videoWhy = [];
  else if (i.src.range !== 'SDR') videoWhy = ['h264_hdr'];
  else if (!exceeds) videoWhy = []; // some other device or source limit (profile, height, unknown bitrate, codec): no honest code
  else if (!i.remote) videoWhy = ['h264_home'];
  else videoWhy = ['h264_off'];

  const keepMp4 = surround || (srcCodec === 'hevc' && hevcOk);
  // MP3 is proven only as plain `audio/mpeg` (MPEG-TS), never inside fMP4: an HEVC-copy / HEVC-encode plan keeps AAC only
  if (!surround && (keepMp4 || wantsHevcEncode) && audioCodecs.includes('mp3') && hls) {
    audioCodecs = ['aac'];
    ({ audio, audioCodec, channels } = stereoAudio());
  }
  return {
    segment: keepMp4 || wantsHevcEncode ? 'mp4' : 'ts',
    videoCodecs, codecParams, audioCodecs, audioChannels: surround ? 6 : 2, audioBitrate, videoBitrate: budget, wantsHevcEncode, keepMp4,
    delivery: { video, videoCodec: video === 'copy' && srcCodec === 'hevc' ? 'hevc' : 'h264', audio, audioCodec, channels, why: [...videoWhy, audioWhy] },
  };
}

/** The HEVC gate's answer for a plan that wants an encode. A refusal keeps ['h264','hevc'] (copying stays possible) and names its reason. */
export function applyGate(p: StreamPlan, g: HevcGate): StreamPlan {
  if (!p.wantsHevcEncode) return p;
  const audioWhy = p.delivery.why.filter((w) => w.startsWith('stereo_') || w.startsWith('surround_'));
  if (g.ok) return { ...p, videoCodecs: ['hevc', 'h264'], delivery: { ...p.delivery, video: 'hevc', videoCodec: 'hevc', why: ['hevc_upload', ...audioWhy] } };
  return { ...p, videoCodecs: ['h264', 'hevc'], segment: p.keepMp4 ? 'mp4' : 'ts', delivery: { ...p.delivery, video: 'h264', videoCodec: 'h264', why: [g.why, ...audioWhy] } };
}

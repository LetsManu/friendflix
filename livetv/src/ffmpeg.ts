// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Encoder } from './system.js';

/**
 * The ffmpeg command lines of the remux and transcode modes (spec §3.3; plan rulings 3 and 23) and the stderr scrubber.
 * ffmpeg never opens a provider URL: an HTTP(S) input arrives on stdin (`-protocol_whitelist pipe`), an SRT input carries the
 * checked IP literal (`-protocol_whitelist srt,udp`). The output is always `-f segment` MPEG-TS files `<dir>/<n>.ts`, each
 * reported as a CSV line on stdout, so livetv owns the playlist (`SegmentWindow`) for every mode.
 */
export type FfInput = { kind: 'pipe'; format: PipeFormat } | { kind: 'srt'; url: string };
/**
 * The demuxer of a pipe input (L5). Always forced (`-f`, and `-format_whitelist` for anything opened from it), never probed from the
 * provider's bytes, so a stream cannot pick ffmpeg's concat, HLS, image or other long-tail demuxers. It is mapped from what we know:
 * the kind of input and the path extension (`segmentFormat`, `urlFormat`), a push feed is always `mpegts`.
 */
export type PipeFormat = 'mpegts' | 'mov' | 'aac' | 'ac3' | 'eac3' | 'mp3' | 'matroska' | 'flv';
/** the demuxer names `-format_whitelist` allows for a forced format (matroska's demuxer also answers to webm) */
const WHITELIST: Record<PipeFormat, string> = { mpegts: 'mpegts', mov: 'mov', aac: 'aac', ac3: 'ac3', eac3: 'eac3', mp3: 'mp3', matroska: 'matroska,webm', flv: 'flv' };
/** the input options of a pipe: stdin only, the given demuxer only */
export const pipeInput = (format: PipeFormat, fd = 0): string[] =>
  ['-protocol_whitelist', 'pipe', '-f', format, '-format_whitelist', WHITELIST[format], '-i', `pipe:${fd}`];
/** the descriptor a separate audio rendition arrives on (run.ts `audioStdin`) */
export const AUDIO_FD = 3;
/** the input options of an SRT caller input: srt/udp only and the demuxer forced to MPEG-TS, as SRT carries (L5 rest) */
export const SRT_INPUT = ['-protocol_whitelist', 'srt,udp', '-f', 'mpegts', '-format_whitelist', 'mpegts'];
const extOf = (uri: string): string => /\.([a-z0-9]+)$/i.exec(uri.split(/[?#]/)[0]!)?.[1]?.toLowerCase() ?? '';
/**
 * The format of an HLS playlist, decided by its FIRST segment (one playlist, one demuxer; a mixed playlist follows its first segment):
 * a MAP or `.m4s`/`.mp4` is fMP4 (`mov`), `.aac` is `aac` (ADTS), `.ac3` is `ac3`, `.ec3`/`.eac3` is `eac3` (packed audio, as an
 * HLS audio rendition may be), `.mp3` is `mp3`, `.ts`, anything else or no extension is `mpegts`.
 */
export const segmentFormat = (uri: string, map: string | null | undefined): PipeFormat => {
  if (map) return 'mov';
  const e = extOf(uri);
  return e === 'm4s' || e === 'mp4' ? 'mov' : e === 'aac' ? 'aac' : e === 'ac3' ? 'ac3' : e === 'ec3' || e === 'eac3' ? 'eac3' : e === 'mp3' ? 'mp3' : 'mpegts';
};
/** the format of a direct (non-HLS, non-SRT) URL by its path extension; anything unknown is MPEG-TS */
export const urlFormat = (url: string): PipeFormat => {
  switch (extOf(url)) {
    case 'aac': return 'aac';
    case 'mp3': return 'mp3';
    case 'mp4': case 'm4a': case 'mov': return 'mov';
    case 'mkv': case 'webm': return 'matroska';
    case 'flv': return 'flv';
    default: return 'mpegts';
  }
};
export interface FfmpegArgsIn {
  mode: 'remux' | 'transcode';
  input: FfInput;
  /**
   * the audio of a separate HLS rendition: a second pipe input on AUDIO_FD, mapped instead of the first input's audio. The map is
   * optional (`1:a:0?`): a rendition without a decodable audio stream still gives the picture. `shift`: seconds the audio input
   * starts after the video input (negative: before): for two MPEG-TS renditions measured from their first timestamps on the
   * encoder's clock (inputs.ts `clockShift`), else from an alignment by program date-time (`alignStart`); the later of the two
   * inputs gets `-itsoffset` (a number, never a URL), as ffmpeg starts each input at 0 by itself. Not `-copyts`: that would also
   * switch off ffmpeg's smoothing of timestamp jumps (a provider discontinuity, a skipped segment, the 33-bit wrap) in the output.
   */
  audioInput?: { format: PipeFormat; shift?: number };
  encoder: Encoder;
  audio: 'copy' | 'aac';
  /** the source's lines (probe); null = unknown, treated as large */
  srcHeight: number | null;
  /** the stream's directory; segments are written as `<dir>/%d.ts` */
  dir: string;
  /** the first segment number (local numbering continues across ffmpeg restarts) */
  startNumber: number;
}

export const SEGMENT_SECONDS = 4;
/** transcodes are scaled to at most this many lines */
export const MAX_LINES = 1080;
/** the render node used for VA-API (the GPU overlay maps /dev/dri) */
export const VAAPI_DEVICE = '/dev/dri/renderD128';
export const AUDIO_BITRATE = 160_000;
const HEAD = ['-hide_banner', '-loglevel', 'error'];
const SCALE = `scale=-2:'min(${MAX_LINES},ih)'`;

/**
 * the audio codecs a browser (hls.js) plays as they are; MP2, AC-3, E-AC-3 and LATM AAC are not among them. The backend's
 * `expectedMode` (backend/src/livetv/streams.ts) repeats this list for a stored probe: change both together.
 */
export function audioPassable(codec: string | undefined): boolean {
  return codec === 'aac' || codec === 'mp3';
}

/** AAC and MP3 are copied; anything else (MP2, AC-3, none known) becomes stereo AAC */
export function audioFor(codec: string | undefined): 'copy' | 'aac' {
  return audioPassable(codec) ? 'copy' : 'aac';
}

/** the video rate in bit/s: 6 Mbit/s, 3 Mbit/s for a source of at most 720 lines */
export function videoBitrate(srcHeight: number | null): number {
  return srcHeight !== null && srcHeight > 0 && srcHeight <= 720 ? 3_000_000 : 6_000_000;
}

/** options that must come before the input (the hardware device of VA-API) */
export function hwArgs(encoder: Encoder): string[] {
  return encoder === 'h264_vaapi' ? ['-vaapi_device', VAAPI_DEVICE] : [];
}

/**
 * The transcode video options (also what the benchmark measures): H.264 High, ≤ 1080 lines, CBR-like rate, keyframes every 2 s.
 * NVENC and QSV mark only IDR frames as key frames, and the segment muxer cuts only at key frames: their forced frames must be
 * IDR (`-forced-idr` / `-forced_idr`), or segments would follow the encoder's own GOP instead of 4 s.
 */
export function videoArgs(encoder: Encoder, srcHeight: number | null): string[] {
  const m = videoBitrate(srcHeight) / 1_000_000;
  const filter = encoder === 'h264_vaapi' ? `${SCALE},format=nv12,hwupload` : encoder === 'h264_qsv' ? `${SCALE},format=nv12` : `${SCALE},format=yuv420p`;
  return [
    '-c:v', encoder,
    ...(encoder === 'libx264' ? ['-preset', 'veryfast'] : []),
    ...(encoder === 'h264_nvenc' ? ['-forced-idr', '1'] : []),
    ...(encoder === 'h264_qsv' ? ['-forced_idr', '1'] : []),
    '-profile:v', 'high',
    '-vf', filter,
    '-b:v', `${m}M`, '-maxrate', `${m}M`, '-bufsize', `${m * 2}M`,
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
  ];
}

const audioArgs = (a: 'copy' | 'aac'): string[] => (a === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ac', '2', '-b:a', '160k']);

export function ffmpegArgs(o: FfmpegArgsIn): string[] {
  const shift = o.audioInput?.shift !== undefined && Number.isFinite(o.audioInput.shift) ? Math.round(o.audioInput.shift * 1000) / 1000 : 0;
  const later = (s: number) => (s > 0 ? ['-itsoffset', s.toFixed(3)] : []);
  const input = [...later(-shift), ...(o.input.kind === 'pipe' ? pipeInput(o.input.format) : [...SRT_INPUT, '-i', o.input.url])];
  const video = o.mode === 'remux' ? ['-c:v', 'copy'] : videoArgs(o.encoder, o.srcHeight);
  return [
    ...HEAD,
    ...(o.mode === 'transcode' ? hwArgs(o.encoder) : []),
    ...input,
    ...(o.audioInput ? [...later(shift), ...pipeInput(o.audioInput.format, AUDIO_FD), '-map', '0:v:0', '-map', '1:a:0?'] : ['-map', '0:v:0', '-map', '0:a:0?']),
    ...video,
    ...audioArgs(o.audio),
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'mpegts',
    '-segment_list', 'pipe:1', '-segment_list_type', 'csv', '-segment_start_number', String(o.startNumber),
    `${o.dir}/%d.ts`,
  ];
}

/** scrubLine looks at no more than this many characters of a line; the rest is dropped (`…[cut]`) */
export const SCRUB_MAX_CHARS = 2048;
const CUT_MARK = ' …[cut]';
/** a name that marks a credential (`username`, `passwd`, `X-Api-Key`, `streamid`, …) */
const CRED_NAME = /user|pass|pwd|secret|auth|token|key|streamid/i;

/**
 * One ffmpeg stderr line as it may be logged (run.ts also replaces the run's data arguments, absolute paths and stream keys):
 * - only the first SCRUB_MAX_CHARS characters are kept; a longer line also loses its last, possibly cut, word and ends in `…[cut]`;
 * - a URL becomes `<input>`; a quoted one up to its closing quote (an SRT URL may hold a space), else up to the next space;
 * - userinfo without a scheme (`anna:geheim@192.0.2.10`) becomes `•••@`;
 * - the value after a credential-like name (any word containing user, pass, pwd, secret, auth, token, key or streamid, followed
 *   by `=` or `:`) becomes `•••`.
 * Linear in the line's length (M1: ffmpeg echoes provider bytes): every pattern starts only at the beginning of a run of its first
 * class (a lookbehind), so no run is scanned from more than one start, and the credential names are checked outside the regex.
 */
export function scrubLine(line: string): string {
  let s = line;
  const cut = s.length > SCRUB_MAX_CHARS;
  if (cut) {
    s = s.slice(0, SCRUB_MAX_CHARS);
    const sp = Math.max(s.lastIndexOf(' '), s.lastIndexOf('\t'));
    s = sp > 0 ? s.slice(0, sp) : '';
  }
  s = s
    .replace(/(['"])[a-z0-9+.-]+:\/\/[^'"]*\1/gi, '$1<input>$1')
    .replace(/(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/\S+/gi, '<input>')
    .replace(/(?<![^\s'"@/]):*[^\s'"@/:]+:[^\s'"@/]+@/g, '•••@');
  return redactCredentials(s) + (cut ? CUT_MARK : '');
}

/** `name=value` / `name: value` with a credential-like name → `name=•••`; every character is looked at a bounded number of times */
function redactCredentials(s: string): string {
  const pair = /(?<!\w)(\w+)(\s*[:=]\s*)/g;
  const value = /[^&\s'"]+/y;
  let out = '';
  let last = 0;
  for (let m = pair.exec(s); m; m = pair.exec(s)) {
    if (!CRED_NAME.test(m[1]!)) continue;
    value.lastIndex = pair.lastIndex;
    if (!value.exec(s)) continue;
    out += `${s.slice(last, pair.lastIndex)}•••`;
    last = pair.lastIndex = value.lastIndex;
  }
  return out + s.slice(last);
}

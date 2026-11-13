// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ATTR_LINE_MAX, scanAttrs } from './attrlist.js';
import { pipeInput, segmentFormat, urlFormat, type PipeFormat } from './ffmpeg.js';
import { FetchError, guardedFetch, type FetchErrorCode, type GuardDeps } from './fetch.js';
import { checkUrl, ipLiteralUrl, resolveChecked } from './netguard.js';
import { TIMEOUT_CODE, type Run } from './run.js';
import type { IngestReader } from './srtingest.js';

/**
 * The stream probe of `POST /v1/probe` (spec §3.2, §3.3; plan ruling 3). ffprobe never opens a provider URL itself: HTTP(S)
 * bytes are fetched by `guardedFetch` and piped into `ffprobe -i pipe:0` (`-protocol_whitelist pipe`); an SRT caller input gets
 * its host replaced by the checked IP literal (`-protocol_whitelist srt,udp`). A `{ push }` input (Task 29) is its feed's ring on
 * stdin: the oldest of the last 4 s, then at most 4 s more of live data; a feed that is not receiving is `unreachable` without
 * starting ffprobe, and without an ingest hub (a caller that wired none) a push input cannot be probed at all: `invalid`. The
 * whole probe has a 10 s budget. The answer never carries a URL, a host or ffprobe output, only the stream facts or a fixed code.
 * `deps.signal` (Task 28: the start probe of a stream that is stopped meanwhile) aborts every fetch and the ffprobe run at once.
 */
export type StreamInput = { url: string; kind: 'hls' | 'ts' | 'srt'; userAgent?: string; allowLan: boolean } | { push: string };
export type ProbeError = 'unreachable' | 'timeout' | 'denied' | 'no_video' | 'invalid' | 'address_refused';
export interface ProbeResult {
  ok: boolean;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; channels: number };
  needs: 'passthrough' | 'remux' | 'transcode';
  error?: ProbeError;
}

export const PROBE_BUDGET_MS = 10_000;
/** HLS playlists (master and media) for passthrough and probing */
export const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
export const SEGMENT_MAX_BYTES = 50 * 1024 * 1024;
/** how much of an MPEG-TS stream ffprobe sees */
export const TS_PROBE_BYTES = 4 * 1024 * 1024;
/** spec §3.3: the default `maxBitrate` of a passthrough variant */
export const DEFAULT_MAX_BITRATE = 10_000_000;
/** a push probe reads the ring and then live data for at most this long */
export const PUSH_PROBE_MS = 4_000;

/** stdin with a forced demuxer (L5: never one ffprobe guesses from the provider's bytes) */
const pipeArgs = (format: PipeFormat) => ['-hide_banner', '-v', 'error', '-show_streams', '-of', 'json', ...pipeInput(format)];
const srtArgs = (url: string) => ['-hide_banner', '-v', 'error', '-protocol_whitelist', 'srt,udp', '-f', 'mpegts', '-format_whitelist', 'mpegts', '-show_streams', '-of', 'json', '-i', url];

class ProbeFail extends Error {
  constructor(readonly code: ProbeError) { super(code); }
}
const fail = (error: ProbeError): ProbeResult => ({ ok: false, needs: 'transcode', error });
const fromFetch = (c: FetchErrorCode): ProbeError =>
  c === 'denied' || c === 'timeout' || c === 'address_refused' ? c : c === 'scheme' || c === 'too_big' ? 'invalid' : 'unreachable';

const hlsName = (c: string) => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-';
const hlsBare = (c: string) => c !== ',';
/** an HLS attribute list (`BANDWIDTH=…,CODECS="a,b"`), scanned in linear time (attrlist.ts; the caller caps the line length) */
export function attrList(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of scanAttrs(s, hlsName, hlsBare)) out.set(a.name, a.quoted ? a.value : a.value.replace(/^"|"$/g, ''));
  return out;
}

/**
 * The variant of an HLS master playlist to use: the highest BANDWIDTH ≤ `maxBitrate`, among the H.264 ones (`avc1`/`avc3`) when
 * any fits; when every variant is above the limit, the lowest one. null when the text has no variant (a media playlist).
 */
export function pickVariant(master: string, maxBitrate: number): { uri: string; bandwidth: number; codecs: string | null } | null {
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  const vars: Array<{ uri: string; bandwidth: number; codecs: string | null }> = [];
  for (let i = 0; i < lines.length; i++) {
    // a variant line longer than ATTR_LINE_MAX is no variant (M2: no provider line is scanned at any length)
    if (!lines[i]!.startsWith('#EXT-X-STREAM-INF:') || lines[i]!.length > ATTR_LINE_MAX) continue;
    const a = attrList(lines[i]!.slice(18));
    let uri: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.startsWith('#EXT-X-STREAM-INF:')) break;
      if (l === '' || l.startsWith('#')) continue;
      uri = l;
      break;
    }
    const bw = Number(a.get('BANDWIDTH'));
    if (uri && Number.isInteger(bw) && bw > 0) vars.push({ uri, bandwidth: bw, codecs: a.get('CODECS') || null });
  }
  if (vars.length === 0) return null;
  const fit = vars.filter((v) => v.bandwidth <= maxBitrate);
  if (fit.length === 0) return vars.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
  const h264 = fit.filter((v) => v.codecs !== null && /\bavc[13]\./i.test(v.codecs));
  return (h264.length ? h264 : fit).reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

type Stream = { codec_type?: unknown; codec_name?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown; channels?: unknown };
const rate = (v: unknown): number => {
  const m = typeof v === 'string' ? /^(\d+)\/(\d+)$/.exec(v) : null;
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0;
};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** ffprobe's JSON → the stream facts (first video and first audio stream) */
function streamsOf(stdout: Buffer): { video?: NonNullable<ProbeResult['video']>; audio?: NonNullable<ProbeResult['audio']> } {
  let streams: Stream[] = [];
  try {
    const j = JSON.parse(stdout.toString('utf8')) as { streams?: unknown };
    if (Array.isArray(j.streams)) streams = j.streams as Stream[];
  } catch {
    return {};
  }
  const v = streams.find((s) => s.codec_type === 'video' && typeof s.codec_name === 'string');
  const a = streams.find((s) => s.codec_type === 'audio' && typeof s.codec_name === 'string');
  const fps = v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0;
  return {
    ...(v ? { video: { codec: String(v.codec_name), width: num(v.width), height: num(v.height), fps: Math.round(fps * 100) / 100 } } : {}),
    ...(a ? { audio: { codec: String(a.codec_name), channels: num(a.channels) } } : {}),
  };
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

/** at most `max` bytes of `body`, then it is closed; a failure is handed to `onError` and ends the stream */
async function* upTo(body: AsyncIterable<Uint8Array>, max: number, onError: (e: unknown) => void): AsyncGenerator<Uint8Array> {
  let left = max;
  try {
    for await (const c of body) {
      if (c.length >= left) { yield c.subarray(0, left); return; }
      left -= c.length;
      yield c;
    }
  } catch (e) {
    onError(e);
  }
}

/** `body` for at most `ms` from the first read (a live feed never ends by itself) */
async function* during(body: AsyncIterable<Uint8Array>, ms: number): AsyncGenerator<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  const end = Date.now() + ms;
  try {
    for (;;) {
      const rest = end - Date.now();
      if (rest <= 0) return;
      let t: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((r) => { t = setTimeout(() => r(null), rest); });
      const r = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(t));
      if (r === null || r.done) return;
      yield r.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}

function resolveUri(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    throw new ProbeFail('invalid');
  }
}

/** `p`, unless the budget runs out first (a hanging DNS lookup): then `timeout` */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new ProbeFail('timeout')), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function probe(input: StreamInput, deps: { run: Run; guard: GuardDeps; signal?: AbortSignal; ingest?: IngestReader }): Promise<ProbeResult> {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const left = () => Math.max(1, deadline - Date.now());
  const abort = deps.signal ? { signal: deps.signal } : {};
  // every response body opened here is closed when the probe ends, read or not (an init segment whose media segment failed, a
  // body ffprobe never asked for)
  const opened: AsyncIterable<Uint8Array>[] = [];
  try {
    if ('push' in input) {
      // livetv's own ingest: no address is looked up or connected to
      const ingest = deps.ingest;
      // no hub wired: this caller cannot read push feeds at all (like an unsupported scheme), not a feed that is merely silent
      if (!ingest) return fail('invalid');
      if (!ingest.receiving(input.push)) return fail('unreachable');
      const ring = ingest.reader(input.push);
      opened.push(ring);
      let ringError: unknown;
      const stdin = upTo(during(ring, PUSH_PROBE_MS), TS_PROBE_BYTES, (e) => { ringError = e; });
      const r = await deps.run('ffprobe', pipeArgs('mpegts'), { timeoutMs: left(), stdin, ...abort });
      if (r.code === TIMEOUT_CODE) return fail('timeout');
      const { video, audio } = streamsOf(r.stdout);
      if (!video) {
        if (ringError !== undefined) throw ringError;
        return fail('no_video');
      }
      return { ok: true, video, ...(audio ? { audio } : {}), needs: video.codec !== 'h264' ? 'transcode' : 'remux' };
    }
    if (deps.signal?.aborted) return fail('timeout');
    const srt = input.kind === 'srt';
    const c = checkUrl(input.url, srt ? ['srt:'] : ['http:', 'https:']);
    if ('error' in c) return fail(c.error === 'host' ? 'address_refused' : 'invalid');
    let pipeError: unknown;
    let result;
    if (srt) {
      const ip = await within(resolveChecked(c.url.hostname, input.allowLan, deps.guard), left());
      result = await deps.run('ffprobe', srtArgs(ipLiteralUrl(c.url, ip)), { timeoutMs: left(), ...abort });
    } else {
      const get = async (url: string, maxBytes: number) => {
        const res = await guardedFetch(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs: left(), maxBytes, ...abort }, deps.guard);
        opened.push(res.body);
        return res;
      };
      let stdin: AsyncIterable<Uint8Array>;
      let format: PipeFormat = 'mpegts';
      if (input.kind === 'hls') {
        // relative references resolve against the URL a playlist was finally served from (after redirects)
        const master = await get(c.url.href, PLAYLIST_MAX_BYTES);
        let base = master.url;
        let media = await readText(master.body);
        if (!media.trimStart().startsWith('#EXTM3U')) return fail('invalid');
        const variant = pickVariant(media, DEFAULT_MAX_BITRATE);
        if (variant) {
          const list = await get(resolveUri(variant.uri, base), PLAYLIST_MAX_BYTES);
          base = list.url;
          media = await readText(list.body);
          if (!media.trimStart().startsWith('#EXTM3U')) return fail('invalid');
        }
        const lines = media.split(/\r?\n/).map((l) => l.trim());
        const seg = lines.find((l) => l !== '' && !l.startsWith('#'));
        if (!seg) return fail('invalid');
        const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP:'));
        const init = mapLine && mapLine.length <= ATTR_LINE_MAX ? attrList(mapLine.slice(11)).get('URI') || undefined : undefined;
        const initBody = init ? (await get(resolveUri(init, base), SEGMENT_MAX_BYTES)).body : null;
        format = segmentFormat(seg, init);
        const segBody = (await get(resolveUri(seg, base), SEGMENT_MAX_BYTES)).body;
        stdin = (async function* () {
          if (initBody) yield* upTo(initBody, SEGMENT_MAX_BYTES, (e) => { pipeError = e; });
          yield* upTo(segBody, SEGMENT_MAX_BYTES, (e) => { pipeError = e; });
        })();
      } else {
        format = urlFormat(c.url.pathname);
        const res = await get(c.url.href, Number.MAX_SAFE_INTEGER);
        stdin = upTo(res.body, TS_PROBE_BYTES, (e) => { pipeError = e; });
      }
      result = await deps.run('ffprobe', pipeArgs(format), { timeoutMs: left(), stdin, ...abort });
    }
    if (result.code === TIMEOUT_CODE) return fail('timeout');
    const { video, audio } = streamsOf(result.stdout);
    if (!video) {
      if (pipeError !== undefined) throw pipeError;
      return fail(srt && result.code !== 0 ? 'unreachable' : 'no_video');
    }
    const needs = video.codec !== 'h264' ? 'transcode' : input.kind === 'hls' ? 'passthrough' : 'remux';
    return { ok: true, video, ...(audio ? { audio } : {}), needs };
  } catch (e) {
    if (e instanceof ProbeFail) return fail(e.code);
    if (e instanceof FetchError) return fail(fromFetch(e.code));
    return fail('invalid');
  } finally {
    for (const b of opened) void Promise.resolve(b[Symbol.asyncIterator]().return?.()).catch(() => {});
  }
}

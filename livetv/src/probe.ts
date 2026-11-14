// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ATTR_LINE_MAX, scanAttrs } from './attrlist.js';
import { audioPassable, pipeInput, segmentFormat, urlFormat, type PipeFormat } from './ffmpeg.js';
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
 * whole probe has a 10 s budget (`budgetMs`: a passthrough start's probe has 5 s, START_PROBE_MS). The answer never carries a URL, a host or ffprobe output, only the stream facts or a fixed code.
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
/**
 * The budget of the probe a passthrough start runs before its first fetch (remux.ts probedPassthrough): it is spent inside the
 * backend's 15-s wait for the first segment (backend/src/livetv/streams.ts FIRST_SEGMENT_MS), so it leaves that wait at least 10 s
 */
export const START_PROBE_MS = 5_000;
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

/** at most this many `#EXT-X-MEDIA` lines of a master playlist are looked at */
export const MAX_MEDIA_LINES = 64;
export interface Variant { uri: string; bandwidth: number; codecs: string | null; audio?: { uri: string } }

/** the HLS characteristic of an audio description track (a narrator describing the picture) */
const DESCRIBES_VIDEO = 'public.accessibility.describes-video';

/**
 * The separate audio rendition of an `AUDIO="group"` variant. The choice is made among ALL the group's `#EXT-X-MEDIA:TYPE=AUDIO`
 * lines, with or without a URI, as a player would: the `DEFAULT=YES` one, else the `AUTOSELECT=YES` one, else the first; among
 * the non-default ones an audio description track (CHARACTERISTICS with `public.accessibility.describes-video`) is taken only when
 * there is nothing else. Only when the chosen rendition has a URI is it a playlist of its own; one without a URI is the audio
 * muxed in the variant (null: nothing to fetch, the variant plays as it is). Lines longer than ATTR_LINE_MAX are skipped; at
 * most MAX_MEDIA_LINES media lines are read.
 */
export function pickAudio(lines: readonly string[], group: string): { uri: string } | null {
  const found: Array<{ uri: string | null; def: boolean; auto: boolean; ad: boolean }> = [];
  let seen = 0;
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-MEDIA:') || l.length > ATTR_LINE_MAX) continue;
    if (++seen > MAX_MEDIA_LINES) break;
    const a = attrList(l.slice(13));
    if (a.get('TYPE') !== 'AUDIO' || a.get('GROUP-ID') !== group) continue;
    const ad = (a.get('CHARACTERISTICS') ?? '').split(',').some((c) => c.trim() === DESCRIBES_VIDEO);
    found.push({ uri: a.get('URI') || null, def: a.get('DEFAULT') === 'YES', auto: a.get('AUTOSELECT') === 'YES', ad });
  }
  const plain = found.filter((f) => !f.ad);
  const best = found.find((f) => f.def) ?? plain.find((f) => f.auto) ?? plain[0] ?? found.find((f) => f.auto) ?? found[0];
  return best?.uri ? { uri: best.uri } : null;
}

/**
 * The variant of an HLS master playlist to use: the highest BANDWIDTH ≤ `maxBitrate`, among the H.264 ones (`avc1`/`avc3`) when
 * any fits; when every variant is above the limit, the lowest one. null when the text has no variant (a media playlist). A variant
 * whose `AUDIO` group has a rendition with its own playlist carries it as `audio` (pickAudio).
 */
export function pickVariant(master: string, maxBitrate: number): Variant | null {
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  const vars: Array<Variant & { group: string | null }> = [];
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
    if (uri && Number.isInteger(bw) && bw > 0) vars.push({ uri, bandwidth: bw, codecs: a.get('CODECS') || null, group: a.get('AUDIO') || null });
  }
  if (vars.length === 0) return null;
  const fit = vars.filter((v) => v.bandwidth <= maxBitrate);
  let best: Variant & { group: string | null };
  if (fit.length === 0) best = vars.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
  else {
    const h264 = fit.filter((v) => v.codecs !== null && /\bavc[13]\./i.test(v.codecs));
    best = (h264.length ? h264 : fit).reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  }
  const audio = best.group ? pickAudio(lines, best.group) : null;
  return { uri: best.uri, bandwidth: best.bandwidth, codecs: best.codecs, ...(audio ? { audio } : {}) };
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

export interface ProbeDeps {
  run: Run;
  guard: GuardDeps;
  signal?: AbortSignal;
  ingest?: IngestReader;
  /** the HLS variant limit of the stream that will play (default DEFAULT_MAX_BITRATE), so the probe looks at the same variant */
  maxBitrate?: number;
  /** the whole probe's budget (default PROBE_BUDGET_MS) */
  budgetMs?: number;
  /**
   * called as soon as the master shows that the chosen variant's audio is a playlist of its own (pickAudio), before anything is
   * sampled: a start whose probe then fails still knows that only a remux plays this source with sound
   */
  onSeparateAudio?: () => void;
}

export async function probe(input: StreamInput, deps: ProbeDeps): Promise<ProbeResult> {
  const deadline = Date.now() + (deps.budgetMs ?? PROBE_BUDGET_MS);
  const left = () => Math.max(1, deadline - Date.now());
  const abort = deps.signal ? { signal: deps.signal } : {};
  // the separate audio rendition's sample (its fetches and its ffprobe) has a controller of its own: a stop aborts it like the rest,
  // and so does the end of the probe, whatever ended it (the video answered first, failed, or the budget ran out)
  const renditionAc = new AbortController();
  const stopRendition = () => renditionAc.abort();
  if (deps.signal?.aborted) renditionAc.abort();
  else deps.signal?.addEventListener('abort', stopRendition, { once: true });
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
    /** the chosen variant's audio is a playlist of its own (pickAudio) */
    let rendition = false;
    /** that rendition's audio facts; undefined when its sample failed, timed out or showed no audio stream */
    let separate: ReturnType<typeof streamsOf>['audio'];
    let renditionDone: Promise<void> = Promise.resolve();
    let result;
    if (srt) {
      const ip = await within(resolveChecked(c.url.hostname, input.allowLan, deps.guard), left());
      result = await deps.run('ffprobe', srtArgs(ipLiteralUrl(c.url, ip)), { timeoutMs: left(), ...abort });
    } else {
      const get = async (url: string, maxBytes: number, signal?: AbortSignal) => {
        const res = await guardedFetch(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs: left(), maxBytes, ...(signal ? { signal } : abort) }, deps.guard);
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
        const variant = pickVariant(media, deps.maxBitrate ?? DEFAULT_MAX_BITRATE);
        if (variant?.audio) {
          rendition = true;
          try { deps.onSeparateAudio?.(); } catch { /* a listener's bug never breaks the probe */ }
        }
        // the first segment of a media playlist (with its init segment) as ffprobe's stdin
        const sample = async (text: string, from: string, onError: (e: unknown) => void, signal?: AbortSignal) => {
          const lines = text.split(/\r?\n/).map((l) => l.trim());
          const seg = lines.find((l) => l !== '' && !l.startsWith('#'));
          if (!seg) throw new ProbeFail('invalid');
          const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP:'));
          const init = mapLine && mapLine.length <= ATTR_LINE_MAX ? attrList(mapLine.slice(11)).get('URI') || undefined : undefined;
          const initBody = init ? (await get(resolveUri(init, from), SEGMENT_MAX_BYTES, signal)).body : null;
          const fmt = segmentFormat(seg, init);
          const segBody = (await get(resolveUri(seg, from), SEGMENT_MAX_BYTES, signal)).body;
          const body = (async function* () {
            if (initBody) yield* upTo(initBody, SEGMENT_MAX_BYTES, onError);
            yield* upTo(segBody, SEGMENT_MAX_BYTES, onError);
          })();
          return { fmt, body };
        };
        if (variant?.audio) {
          // audio in a playlist of its own: its facts come from its own first segment, sampled while the video is (one budget for
          // both). Whatever goes wrong with it (playlist or segment unreachable, no audio stream found, the budget spent) leaves
          // its facts unknown but never fails the probe or turns it into a passthrough: the answer is remux either way
          const audioUri = resolveUri(variant.audio.uri, master.url);
          renditionDone = (async () => {
            const signal = renditionAc.signal;
            const list = await get(audioUri, PLAYLIST_MAX_BYTES, signal);
            const text = await readText(list.body);
            if (!text.trimStart().startsWith('#EXTM3U')) return;
            const a = await sample(text, list.url, () => {}, signal);
            const r = await deps.run('ffprobe', pipeArgs(a.fmt), { timeoutMs: left(), stdin: a.body, signal });
            if (r.code !== TIMEOUT_CODE) separate = streamsOf(r.stdout).audio;
          })().catch(() => {});
        }
        if (variant) {
          const list = await get(resolveUri(variant.uri, base), PLAYLIST_MAX_BYTES);
          base = list.url;
          media = await readText(list.body);
          if (!media.trimStart().startsWith('#EXTM3U')) return fail('invalid');
        }
        const v = await sample(media, base, (e) => { pipeError = e; });
        format = v.fmt;
        stdin = v.body;
      } else {
        format = urlFormat(c.url.pathname);
        const res = await get(c.url.href, Number.MAX_SAFE_INTEGER);
        stdin = upTo(res.body, TS_PROBE_BYTES, (e) => { pipeError = e; });
      }
      result = await deps.run('ffprobe', pipeArgs(format), { timeoutMs: left(), stdin, ...abort });
      await within(renditionDone, left()).catch(() => {});
    }
    if (result.code === TIMEOUT_CODE) return fail('timeout');
    const { video, audio: muxed } = streamsOf(result.stdout);
    // a separate rendition is what plays, never the variant's own audio; unknown (undefined) when its sample failed
    const audio = rendition ? separate : muxed;
    if (!video) {
      if (pipeError !== undefined) throw pipeError;
      return fail(srt && result.code !== 0 ? 'unreachable' : 'no_video');
    }
    // An HLS source is passed through untouched only when a browser can play its audio (or it has none) and that audio is in the
    // variant itself; else the audio becomes AAC. A separate rendition always needs a remux (passthrough plays one playlist only),
    // also when its sample failed: the remux then reads it as a second input and makes AAC of whatever it holds (`1:a:0?`, so a
    // rendition that turns out silent still gives the picture). Answering passthrough there would be the silent picture this rule
    // exists to prevent; a remux of a working channel plays it either way (the driver drops a rendition it cannot read at all).
    const needs = video.codec !== 'h264' ? 'transcode' : input.kind === 'hls' && !rendition && (!audio || audioPassable(audio.codec)) ? 'passthrough' : 'remux';
    return { ok: true, video, ...(audio ? { audio } : {}), needs };
  } catch (e) {
    if (e instanceof ProbeFail) return fail(e.code);
    if (e instanceof FetchError) return fail(fromFetch(e.code));
    return fail('invalid');
  } finally {
    renditionAc.abort();
    deps.signal?.removeEventListener('abort', stopRendition);
    for (const b of opened) void Promise.resolve(b[Symbol.asyncIterator]().return?.()).catch(() => {});
  }
}

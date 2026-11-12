// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FetchError, guardedFetch, type GuardDeps, type GuardedResponse } from './fetch.js';
import { checkUrl, ipLiteralUrl, resolveChecked } from './netguard.js';
import { PLAYLIST_TIMEOUT_MS, SEGMENT_TIMEOUT_MS, START_SEGMENTS, parseMedia, type FetchFn } from './passthrough.js';
import { DEFAULT_MAX_BITRATE, PLAYLIST_MAX_BYTES, SEGMENT_MAX_BYTES, pickVariant, type StreamInput } from './probe.js';

/**
 * What ffmpeg reads for a remux or transcode (plan ruling 3): never a provider URL. HTTP(S) inputs are fetched by livetv
 * (`guardedFetch`) and handed over as a byte stream for ffmpeg's stdin: an MPEG-TS stream as it arrives, an HLS playlist as its
 * segments one after the other (polled like passthrough). An SRT caller input keeps its URL with the host replaced by the
 * checked IP literal. `{ push }` inputs arrive with Task 29.
 */
export type FfmpegInput = { kind: 'pipe'; stdin: AsyncIterable<Uint8Array> } | { kind: 'srt'; url: string };
export interface OpenedInput {
  ffInput: FfmpegInput;
  /** ends every fetch of this input (an unread body included) */
  close(): void;
}
export interface InputDeps { guard: GuardDeps; fetch?: FetchFn; signal?: AbortSignal; maxBitrate?: number }

/** an MPEG-TS stream that delivers nothing for this long ends (ffmpeg sees EOF, the driver reconnects) */
export const STREAM_IDLE_MS = 20_000;
/** the largest timer Node accepts: an endless body has no whole-fetch budget, the idle watchdog guards it instead */
const FOREVER_MS = 2 ** 31 - 1;
const MIN_POLL_S = 1;
const MAX_POLL_S = 15;

function resolveRef(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    throw new FetchError('unreachable');
  }
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    const onAbort = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `body`, ended when no chunk arrives for `ms` (then `onIdle` aborts the fetch, so the pending read fails and the socket closes) */
async function* watched(body: AsyncIterable<Uint8Array>, ms: number, onIdle: () => void): AsyncGenerator<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  let idle = false;
  try {
    for (;;) {
      let t: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((r) => { t = setTimeout(() => r(null), ms); });
      const r = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(t));
      if (r === null) { idle = true; onIdle(); return; }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    if (idle) void Promise.resolve(it.return?.()).catch(() => {});
    else await Promise.resolve(it.return?.()).catch(() => {});
  }
}

/**
 * The segments to take from a media playlist: at the first look, or when the provider's sequence went back (an encoder
 * restart), the newest START_SEGMENTS; else every segment after `last`, and only the newest START_SEGMENTS of them when some were
 * missed.
 */
function pick<T extends { seq: number }>(segs: T[], last: number | null): T[] {
  if (last === null || (segs.length > 0 && segs.at(-1)!.seq < last)) return segs.slice(-START_SEGMENTS);
  const after = segs.filter((s) => s.seq > last);
  return after.length > 0 && after[0]!.seq > last + 1 ? after.slice(-START_SEGMENTS) : after;
}

type Get = (url: string, maxBytes: number, timeoutMs: number) => Promise<GuardedResponse>;

/** an HLS input as one byte stream: the newest segments first, then every new one (a segment gone at the provider is skipped) */
async function* hlsBytes(first: { text: string; base: string; url: string }, get: Get, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let pl = { text: first.text, base: first.base };
  let last: number | null = null;
  let initUrl: string | null = null;
  while (!signal.aborted) {
    const p = parseMedia(pl.text);
    if (!p) throw new FetchError('unreachable');
    const segs = p.segments.map((s, i) => ({ ...s, seq: p.mediaSequence + i }));
    for (const s of pick(segs, last)) {
      if (signal.aborted) return;
      if (s.map) {
        const u = resolveRef(s.map, pl.base);
        if (u !== initUrl) {
          yield* (await get(u, SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS)).body;
          initUrl = u;
        }
      }
      let r: GuardedResponse;
      try {
        r = await get(resolveRef(s.uri, pl.base), SEGMENT_MAX_BYTES, SEGMENT_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof FetchError && e.code === 'not_found') { last = s.seq; continue; }
        throw e;
      }
      yield* r.body;
      last = s.seq;
    }
    if (!(await wait(Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, p.targetDuration / 2)) * 1000, signal))) return;
    const r = await get(first.url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
    pl = { text: await readText(r.body), base: r.url };
  }
}

export async function openInput(input: StreamInput, deps: InputDeps): Promise<OpenedInput> {
  // `{ push }` reads livetv's own ingest (Task 29)
  if ('push' in input) throw new FetchError('scheme');
  if (input.kind === 'srt') {
    const c = checkUrl(input.url, ['srt:']);
    if ('error' in c) throw new FetchError(c.error === 'host' ? 'address_refused' : c.error === 'scheme' ? 'scheme' : 'unreachable');
    const ip = await resolveChecked(c.url.hostname, input.allowLan, deps.guard);
    return { ffInput: { kind: 'srt', url: ipLiteralUrl(c.url, ip) }, close: () => {} };
  }
  const ac = new AbortController();
  const outer = () => ac.abort();
  if (deps.signal?.aborted) ac.abort();
  else deps.signal?.addEventListener('abort', outer, { once: true });
  const close = () => { deps.signal?.removeEventListener('abort', outer); ac.abort(); };
  const fetchFn: FetchFn = deps.fetch ?? ((url, o) => guardedFetch(url, o, deps.guard));
  const get: Get = (url, maxBytes, timeoutMs) =>
    fetchFn(url, { allowLan: input.allowLan, userAgent: input.userAgent, timeoutMs, maxBytes, signal: ac.signal });
  try {
    if (input.kind === 'ts') {
      const res = await get(input.url, Number.MAX_SAFE_INTEGER, FOREVER_MS);
      return { ffInput: { kind: 'pipe', stdin: watched(res.body, STREAM_IDLE_MS, close) }, close };
    }
    // HLS: the master (or media) playlist now, so an unreachable provider fails before ffmpeg starts
    const m = await get(input.url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
    let text = await readText(m.body);
    let base = m.url;
    let url = m.url;
    const v = pickVariant(text, deps.maxBitrate ?? DEFAULT_MAX_BITRATE);
    if (v) {
      url = resolveRef(v.uri, base);
      const r = await get(url, PLAYLIST_MAX_BYTES, PLAYLIST_TIMEOUT_MS);
      text = await readText(r.body);
      base = r.url;
    }
    // throws PlaylistRefused (encrypted, byte ranges) now: the driver fails the stream
    if (!parseMedia(text)) throw new FetchError('unreachable');
    return { ffInput: { kind: 'pipe', stdin: hlsBytes({ text, base, url }, get, ac.signal) }, close };
  } catch (e) {
    close();
    throw e;
  }
}

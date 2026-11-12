// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { conversionsView, type ConversionsView } from '../convbench.js';
import type { Ctx } from '../ctx.js';
import { CHANNEL_COLUMNS, CHANNEL_FROM } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { detectLivetv, livetvSystem } from './detect.js';
import { listEvents, pushEvent, type LiveEvent } from './events.js';
import { gpuAdvice, type GpuAdvice } from './gpu.js';
import type { IngestState, Mode, StreamView } from './wire.js';

/**
 * Admin -> Live-TV -> *Live-Status* (spec §9.5): one answer for the whole tab, and *Stoppen*. Streams and push feeds come from livetv
 * (`GET /v1/streams`, `GET /v1/ingest`); a livetv without those endpoints answers 404 = none yet (ruling 24), and a livetv that does
 * not answer shows empty lists, never an error. Nothing here is a URL: a stream key, a provider URL or a stream id never reaches the
 * answer (only the fields below are copied, by name).
 */
export interface LiveStatus {
  version: string | null;
  budget: ConversionsView;
  system: { cpuPct: number; gpuPct: number | null; cache: { usedBytes: number; maxBytes: number } };
  streams: Array<{ channelId: string; name: string; logoHash: string | null; mode: Mode; viewers: number; since: number; bitrate: number | null; input: 'ok' | 'reconnecting' | 'failed'; reconnects: number }>;
  ingest: Array<{ channelId: string; name: string; port: number; state: IngestState['state']; since: number | null; bitrate: number | null; rejected1h: number }>;
  events: LiveEvent[];
  /** channel id -> name for every channel an event names (running or not); ids and names only */
  channels: Record<string, string>;
  gpu: { advice: GpuAdvice | null };
}

const LIST_TIMEOUT_MS = 3_000;
const JF_TIMEOUT_MS = 3_000;
const MEMO_MS = 10_000;
const MODES: readonly string[] = ['passthrough', 'remux', 'transcode'];
const STATES: readonly string[] = ['starting', 'running', 'reconnecting', 'failed'];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 500;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** a list answer of livetv, or [] (404 = no such endpoint yet, ruling 24; anything else = livetv not helping: nothing to show) */
async function list(ctx: Ctx, path: string): Promise<unknown[]> {
  try {
    const raw = await livetvCall<unknown>(ctx, 'GET', path, undefined, { timeoutMs: LIST_TIMEOUT_MS });
    return Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : [];
  } catch (e) {
    if (e instanceof LivetvError) return [];
    throw e;
  }
}

/**
 * Who watches a channel (a count, never who): Task 31 brings the viewer keys; until then nobody is counted. The one place to change
 * when they exist.
 */
async function viewersOf(_ctx: Ctx, _channelIds: readonly string[]): Promise<Map<string, number>> {
  return new Map();
}

/** the channels' effective names, logo hashes and numbers by id (ids that are not ours are simply absent) */
async function channelFacts(ctx: Ctx, ids: readonly string[]): Promise<Map<string, { name: string; logoHash: string | null; number: number | null }>> {
  const ours = [...new Set(ids.filter((i) => ID_RE.test(i)))];
  if (!ours.length) return new Map();
  const r = await ctx.db.query<{ id: string; name: string; logo_hash: string | null; number: number | null }>(
    `select ${CHANNEL_COLUMNS} from ${CHANNEL_FROM} where c.id = any($1::uuid[])`, [ours]);
  return new Map(r.rows.map((x) => [x.id, { name: x.name, logoHash: x.logo_hash, number: x.number }]));
}

const byNumberThenName = (a: { number: number | null; name: string }, b: { number: number | null; name: string }) =>
  (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);

/** `GET /v1/streams`, read defensively: an item that is not a StreamView is dropped, and the stream key is never copied */
function parseStreams(raw: unknown[]): Array<Omit<StreamView, 'streamKey'>> {
  const out: Array<Omit<StreamView, 'streamKey'>> = [];
  for (const x of raw) {
    const o = rec(x);
    if (!o || typeof o.channelId !== 'string' || !MODES.includes(o.mode as string) || !STATES.includes(o.state as string)) continue;
    const since = num(o.since);
    if (since === null) continue;
    const errors = Array.isArray(o.errors)
      ? o.errors.flatMap((e) => { const r = rec(e); return r && (r.code === 'input_lost' || r.code === 'input_back') && num(r.at) !== null ? [{ at: r.at as number, code: r.code as 'input_lost' | 'input_back' }] : []; })
      : [];
    out.push({ channelId: o.channelId, mode: o.mode as Mode, since, state: o.state as StreamView['state'], bitrate: num(o.bitrate), errors, lastSegmentAt: num(o.lastSegmentAt) });
  }
  return out;
}

/** `GET /v1/ingest`, read defensively */
function parseIngest(raw: unknown[]): IngestState[] {
  const out: IngestState[] = [];
  for (const x of raw) {
    const o = rec(x);
    const port = num(o?.port);
    if (!o || typeof o.channelId !== 'string' || port === null || !Number.isInteger(port) || (o.state !== 'idle' && o.state !== 'receiving')) continue;
    const n = num(o.rejected1h);
    out.push({ channelId: o.channelId, port, state: o.state, since: num(o.since), bitrate: num(o.bitrate), rejected1h: n !== null && n > 0 ? Math.min(Math.floor(n), 1_000_000) : 0 });
  }
  return out;
}

/** (none when off); null = unknown (Plex, unreachable, slow) */
export async function readHwAccel(ctx: Ctx): Promise<string | null> {
  const read = ctx.jf.admin.encoderSettings?.bind(ctx.jf.admin);
  if (!read) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const e = await Promise.race([read(), new Promise<null>((res) => { timer = setTimeout(() => res(null), JF_TIMEOUT_MS); timer.unref?.(); })]);
    return e?.hwAccel ?? null;
  } catch { return null; } finally { clearTimeout(timer); }
}

/** `hwAccel`: Jellyfin's hardware acceleration, memoised by the caller (the tab polls every 5 s; the memo holds it 10 s) */
export async function liveStatus(ctx: Ctx, hwAccel: () => Promise<string | null> = () => readHwAccel(ctx)): Promise<LiveStatus> {
  const [det, budget, sys, rawStreams, rawIngest, events] = await Promise.all([
    detectLivetv(ctx, MEMO_MS),
    conversionsView(ctx),
    livetvSystem(ctx),
    list(ctx, '/v1/streams'),
    list(ctx, '/v1/ingest'),
    listEvents(ctx),
  ]);
  const jellyfin = sys ? await hwAccel() : null;
  const running = parseStreams(rawStreams);
  const feeds = parseIngest(rawIngest);
  const [facts, viewers] = await Promise.all([channelFacts(ctx, [...running, ...feeds, ...events].map((x) => x.channelId).filter((i): i is string => typeof i === 'string')), viewersOf(ctx, running.map((s) => s.channelId))]);

  const streams = running.flatMap((s) => {
    const f = facts.get(s.channelId);
    if (!f) return []; // a stream of a channel that is gone: nothing to name it by
    const input: LiveStatus['streams'][number]['input'] = s.state === 'reconnecting' ? 'reconnecting' : s.state === 'failed' ? 'failed' : 'ok';
    return [{ number: f.number, channelId: s.channelId, name: f.name, logoHash: f.logoHash, mode: s.mode, viewers: viewers.get(s.channelId) ?? 0, since: s.since, bitrate: s.bitrate, input, reconnects: s.errors.filter((e) => e.code === 'input_lost').length }];
  }).sort(byNumberThenName).map(({ number: _number, ...s }) => s);

  const ingest = feeds.flatMap((i) => {
    const f = facts.get(i.channelId);
    return f ? [{ channelId: i.channelId, name: f.name, port: i.port, state: i.state, since: i.since, bitrate: i.bitrate, rejected1h: i.rejected1h }] : [];
  }).sort((a, b) => a.port - b.port);

  return {
    version: det.version,
    budget,
    system: { cpuPct: sys?.cpu.loadPct ?? 0, gpuPct: sys?.gpu.busyPct ?? null, cache: { usedBytes: sys?.cache.usedBytes ?? 0, maxBytes: sys?.cache.maxBytes ?? 0 } },
    streams,
    ingest,
    events,
    channels: Object.fromEntries(events.flatMap((e) => { const f = e.channelId ? facts.get(e.channelId) : undefined; return e.channelId && f ? [[e.channelId, f.name] as const] : []; })),
    gpu: { advice: sys && jellyfin !== null ? gpuAdvice(jellyfin, sys) : null },
  };
}

/**
 * *Stoppen* / *Neu starten*: `DELETE /v1/streams/:channelId` (a stream that is not running answers 204 too; a 404 from an older livetv is
 * tolerated). Throws the LivetvError when livetv is not reached; only then nothing is recorded (a failing event push is logged, not thrown). The event says *stopped_by_admin*.
 */
export async function stopStream(ctx: Ctx, channelId: string, log?: { warn(o: object, m: string): void }): Promise<void> {
  try {
    await livetvCall<undefined>(ctx, 'DELETE', `/v1/streams/${channelId}`, undefined, { timeoutMs: 10_000 });
  } catch (e) {
    if (!(e instanceof LivetvError && e.status === 404)) throw e;
  }
  // the stop happened; a failing event ring must not turn it into a 500 without an audit entry
  await pushEvent(ctx, { level: 'info', code: 'stopped_by_admin', channelId }).catch((err: unknown) => log?.warn({ err }, 'livetv stop event not recorded'));
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { admitConversion, bindConvGrant, dropConvGrant, setLiveSource, type ConvEntry } from '../convbudget.js';
import { within } from '../convexempt.js';
import { decrypt } from '../crypto.js';
import type { Ctx } from '../ctx.js';
import { CHANNEL_SELECT, toEffective, type EffectiveChannel, type EffectiveRow, type Ingest, type ProbeRec, type StreamKind } from './channels.js';
import { LivetvError, livetvCall } from './client.js';
import { detectLivetv, livetvInstalled } from './detect.js';
import { liveEncoder } from './encoder.js';
import { nowNext, type Prog } from './epg.js';
import { pushEvent } from './events.js';
import { syncIngest } from './ownfeeds.js';
import { channelSet, type LivetvProfile, type LivetvUser } from './rights.js';
import { liveViewKey } from './tokens.js';
import type { Mode, StartBody, StreamInput, StreamView } from './wire.js';

/**
 * The shared live streams as the backend runs them (spec §7.4): one stream per channel in livetv for every viewer. A watch on a running
 * channel joins it and never touches the budget; a watch on a channel that is not running starts it once (KV lock `ltv:start:<id>`,
 * concurrent first viewers wait for that start and join it, Review Focus 1): push feed receiving?, the source's connection limit, the
 * budget slot when the expected mode transcodes (grant bound at once to the key `live:<id>` that the budget's live source lists, F8),
 * `POST /v1/streams`, then the first segment within 15 s, else the stream is stopped and the watch fails (502). `livetvTick` stops a
 * stream 60 s after its last viewer, re-sends the push set when livetv restarted and turns livetv's stream and ingest facts into events.
 *
 * Nothing here logs or answers a stream URL, a stream id, a passphrase or a stream key (the key goes only to the gateway's authz).
 */

export const START_LOCK_TTL_S = 20;
export const FIRST_SEGMENT_MS = 15_000;
export const POLL_MS = 500;
/** a stream nobody watched for this long stops (spec §7.4) */
export const STOP_AFTER_MS = 60_000;
/** the `GET /v1/streams` cache of the budget's live source and of streamKeyFor */
export const LIST_CACHE_MS = 5_000;
const LIST_TIMEOUT_MS = 3_000;
/** the budget reads livetv under its own 3-s lock: never longer than the media server's session read */
const BUDGET_READ_MS = 800;
/** a list older than this is not used in place of an unanswered read */
const STALE_MAX_MS = 60_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
/** a second watcher waits for a start in progress at most this long (the starter's lock, plus its first-segment wait) */
const JOIN_WAIT_MS = (START_LOCK_TTL_S + 5) * 1000;
/** renewed before every step of the tick (each step is bounded by a 10-s call), so it never lapses under a running tick */
const TICK_LOCK_TTL_S = 14;
const ZERO_TTL_S = 3600;
const REJECT_NOTE_TTL_S = 600;
const ERR_SEEN_TTL_S = 86_400;
const BOOT_TTL_S = 30 * 86_400;
/** the tick's view of livetv's bootId: at most this old (detect refreshes it every minute anyway) */
const BOOT_MAX_AGE_MS = 15_000;

const startKey = (channelId: string) => `ltv:start:${channelId}`;
const zeroKey = (channelId: string) => `ltv:zero:${channelId}`;
const errSeenKey = (channelId: string) => `ltv:errseen:${channelId}`;
const rejectKey = (channelId: string) => `ltv:rejected:${channelId}`;
const BOOT_KEY = 'ltv:boot';
const TICK_KEY = 'ltv:tick';
const joinKey = (channelId: string) => `ltv:join:${channelId}`;
/** a join that has answered but not yet minted its token (the mint seeds the viewer key): the idle stop leaves the channel alone this long */
const JOIN_MARK_TTL_S = 15;
const NEG_MS = 2_000;
/** the budget key of a live channel's conversion: the grant is bound to it and liveConversions lists it (F8) */
const convKey = (channelId: string) => `live:${channelId}`;

const MODES: readonly string[] = ['passthrough', 'remux', 'transcode'];
const STATES: readonly string[] = ['starting', 'running', 'reconnecting', 'failed'];
const CHANNEL_ID_RE = /^[\w-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_KEY_RE = /^[0-9a-f]{32}$/;
const FRESH_PROBE_MS = 24 * 3_600_000;
const MAX_ITEMS = 500;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The mode a start asks livetv for (spec §3.3): HLS passes through; MPEG-TS remuxes unless its probe says it must transcode; SRT
 * (pulled or pushed) uses the needs of a probe younger than 24 h (ruling 29), else it counts as a transcode (a slot is taken, and given
 * back when livetv's own probe at start says remux after all).
 */
export function expectedMode(ch: { streamKind: StreamKind; probe: ProbeRec | null }, now: number): Mode {
  if (ch.streamKind === 'hls') return 'passthrough';
  const p = ch.probe;
  if (ch.streamKind === 'ts') return p?.needs === 'transcode' ? 'transcode' : 'remux';
  const at = p ? Date.parse(p.at) : NaN;
  return p && p.ok && p.needs && Number.isFinite(at) && now - at < FRESH_PROBE_MS ? p.needs : 'transcode';
}

/** a running channel as a refusal lists it (spec §7.2): only channels the asking profile may see */
export interface RunningChannel { id: string; number: number | null; name: string; logo: string | null; now?: Prog }
export type WatchError =
  | { status: 503; error: 'live_full'; running: RunningChannel[] }
  | { status: 503; error: 'provider_limit'; max: number; running: RunningChannel[] }
  | { status: 502; error: 'channel_unreachable' }
  | { status: 409; error: 'not_receiving' };
/** who watches: the account (its role decides what `running` lists) and the device */
export interface Watcher { userId: string; deviceId: string; role: string }

// ---- livetv's stream list ----

/** `GET /v1/streams`, read defensively: an item that is not a StreamView is dropped (a stream key that is not 32 hex too) */
function parseStreams(raw: unknown): StreamView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StreamView[] = [];
  for (const x of raw.slice(0, MAX_ITEMS)) {
    const o = x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    if (!o || typeof o.channelId !== 'string' || !CHANNEL_ID_RE.test(o.channelId) || typeof o.streamKey !== 'string' || !STREAM_KEY_RE.test(o.streamKey)) continue;
    if (!MODES.includes(o.mode as string) || !STATES.includes(o.state as string)) continue;
    const since = num(o.since);
    if (since === null) continue;
    const errors = Array.isArray(o.errors) ? o.errors.flatMap((e: unknown) => {
      const r = e && typeof e === 'object' ? (e as Record<string, unknown>) : null;
      const at = num(r?.at);
      if (!r || at === null || (r.code !== 'input_lost' && r.code !== 'input_back')) return [];
      const seconds = num(r.seconds);
      return [{ at, code: r.code as 'input_lost' | 'input_back', ...(seconds !== null ? { seconds } : {}) }];
    }) : [];
    out.push({ channelId: o.channelId, streamKey: o.streamKey, mode: o.mode as Mode, since, state: o.state as StreamView['state'], bitrate: num(o.bitrate), errors, lastSegmentAt: num(o.lastSegmentAt) });
  }
  return out;
}

/** null = livetv did not answer (or not with a list); a livetv without the endpoint (404, ruling 24) runs nothing */
async function fetchStreams(ctx: Ctx, timeoutMs: number): Promise<StreamView[] | null> {
  try {
    return parseStreams(await livetvCall<unknown>(ctx, 'GET', '/v1/streams', undefined, { timeoutMs }));
  } catch (e) {
    if (e instanceof LivetvError) return e.status === 404 ? [] : null;
    throw e;
  }
}

/** per ctx: the last read (shared while it runs) and the last list that was answered */
let lists = new WeakMap<object, { at: number; p: Promise<StreamView[] | null> }>();
const good = new WeakMap<object, { at: number; list: StreamView[] }>();

/** Drops the cached `GET /v1/streams` (after a start, a stop or a release): the next budget count and streamKeyFor ask livetv again. */
export function invalidateLiveConversions(): void {
  lists = new WeakMap();
  ingestReads = new WeakMap();
  misses = new WeakMap();
}

/** per ctx: channels the stream list did not have, until when (a token of a stopped channel polls the gateway's authz; each miss would ask livetv) */
let misses = new WeakMap<object, Map<string, number>>();

/** the stream list, from the cache when it is younger than `maxAgeMs` (0 = always a fresh read, which then fills the cache) */
async function readStreams(ctx: Ctx, maxAgeMs = 0): Promise<StreamView[] | null> {
  const hit = lists.get(ctx);
  if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return hit.p;
  const p = fetchStreams(ctx, LIST_TIMEOUT_MS).catch(() => null);
  lists.set(ctx, { at: Date.now(), p });
  const list = await p;
  if (list) good.set(ctx, { at: Date.now(), list });
  return list;
}

/** the stream of a channel that is not failed (a failed one is replaced by the next start) */
const activeOf = (list: readonly StreamView[] | null, channelId: string) => list?.find((s) => s.channelId === channelId && s.state !== 'failed');

/**
 * The stream key of a running channel for `/internal/authz/live` (null = not running: the token answers 410). From the 5-s cache; a
 * channel the cached list does not have is asked for once more (a stream started since that read).
 */
export async function streamKeyFor(ctx: Ctx, channelId: string): Promise<string | null> {
  if (!livetvInstalled(ctx)) return null;
  const miss = misses.get(ctx);
  if ((miss?.get(channelId) ?? 0) > Date.now()) return null;
  const cached = await readStreams(ctx, LIST_CACHE_MS);
  const v = cached?.some((s) => s.channelId === channelId) ? activeOf(cached, channelId) : activeOf(await readStreams(ctx), channelId);
  if (!v) {
    const m = misses.get(ctx) ?? new Map<string, number>();
    if (m.size >= 1000) m.clear();
    m.set(channelId, Date.now() + NEG_MS);
    misses.set(ctx, m);
  }
  return v?.streamKey ?? null;
}

/**
 * The budget's live source (spec §5.1): every stream livetv runs in mode transcode, as `{ kind: 'live', key: 'live:<channelId>' }`
 * (countConversions keeps one entry per key, so the start's grant bound to that key is not counted twice, F8). `GET /v1/streams` is
 * cached 5 s and read at most 800 ms here (the budget lock); an unanswered read uses the last list of the past minute, else none.
 */
export async function liveConversions(ctx: Ctx): Promise<ConvEntry[]> {
  if (!livetvInstalled(ctx)) return [];
  let list = await within(() => readStreams(ctx, LIST_CACHE_MS), BUDGET_READ_MS) ?? null;
  if (!list) {
    const last = good.get(ctx);
    list = last && Date.now() - last.at < STALE_MAX_MS ? last.list : [];
  }
  const tr = list.filter((s) => s.mode === 'transcode' && s.state !== 'failed');
  const ids = tr.map((s) => s.channelId).filter((id) => UUID_RE.test(id));
  const names = ids.length
    ? new Map((await ctx.db.query<{ id: string; name: string }>(`select id, name from (${CHANNEL_SELECT} where c.id = any($1::uuid[])) e`, [ids])).rows.map((r) => [r.id, r.name] as const))
    : new Map<string, string>();
  return tr.map((s) => ({ kind: 'live', key: convKey(s.channelId), label: names.get(s.channelId) ?? null, since: s.since, device: null, userId: null }));
}

/**
 * Viewers per channel (spec §7.4): live tokens touched within the last 45 s (`ltv:view:<hash>`, value = channel id; a mint seeds it, F9).
 * Casts and admin test previews are tokens too, so they count. `exceptHash` leaves one token out (a switching device, Task 32).
 */
export async function viewerCounts(ctx: Ctx, o: { exceptHash?: string } = {}): Promise<Map<string, number>> {
  const skip = o.exceptHash ? liveViewKey(o.exceptHash) : null;
  const keys = (await ctx.kv.keys(liveViewKey(''))).filter((k) => k !== skip);
  const out = new Map<string, number>();
  if (!keys.length) return out;
  for (const id of await ctx.kv.mget(keys)) if (id) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** the running channels this profile may see, by number then name (a refusal's `running`, spec §7.2) */
export async function runningList(ctx: Ctx, user: LivetvUser, profile: LivetvProfile, list?: readonly StreamView[] | null): Promise<RunningChannel[]> {
  const l = list ?? (await readStreams(ctx, LIST_CACHE_MS)) ?? [];
  const visible = await channelSet(ctx, user, profile);
  const ids = [...new Set(l.filter((s) => s.state !== 'failed' && visible.has(s.channelId)).map((s) => s.channelId))];
  if (!ids.length) return [];
  const rows = (await ctx.db.query<EffectiveRow>(`${CHANNEL_SELECT} where c.id = any($1::uuid[])`, [ids])).rows.map(toEffective);
  const nn = await nowNext(ctx, ids);
  return rows
    .sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name))
    .map((c) => {
      const now = nn.get(c.id)?.now;
      return { id: c.id, number: c.number, name: c.name, logo: c.logoHash ? `/api/livetv/logos/${c.logoHash}` : null, ...(now ? { now } : {}) };
    });
}

/** the channels livetv runs right now (not failed), from the 5-s stream cache; null = livetv did not answer (the list then shows nothing running) */
export async function runningChannelIds(ctx: Ctx): Promise<Set<string> | null> {
  const l = await readStreams(ctx, LIST_CACHE_MS);
  return l ? new Set(l.filter((s) => s.state !== 'failed').map((s) => s.channelId)) : null;
}

/** per ctx: the last `GET /v1/ingest` read (shared while it runs), so a household polling the list does not ask livetv per request */
let ingestReads = new WeakMap<object, { at: number; p: Promise<Set<string> | null> }>();

async function fetchReceiving(ctx: Ctx): Promise<Set<string> | null> {
  try {
    const raw = await livetvCall<unknown>(ctx, 'GET', '/v1/ingest', undefined, { timeoutMs: LIST_TIMEOUT_MS });
    const out = new Set<string>();
    for (const x of Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : []) {
      const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
      if (o && typeof o.channelId === 'string' && o.state === 'receiving') out.add(o.channelId);
    }
    return out;
  } catch (e) {
    // a livetv without the endpoint (404) receives nothing; any other failure = unknown
    return e instanceof LivetvError && e.status === 404 ? new Set() : null;
  }
}

/** the push feeds livetv receives from right now (`GET /v1/ingest`, state `receiving`), cached 5 s; null = livetv did not answer */
export async function receivingChannelIds(ctx: Ctx): Promise<Set<string> | null> {
  const hit = ingestReads.get(ctx);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.p;
  const p = fetchReceiving(ctx);
  ingestReads.set(ctx, { at: Date.now(), p });
  return p;
}

/** the budget (convbudget.ts) lists the live transcodes through this; registered here so convbudget imports nothing of livetv */
setLiveSource(liveConversions);

// ---- start and join ----

/** the first segment of a channel's stream within `ms` (polled every 500 ms); null when none came, or the stream failed */
async function firstSegment(ctx: Ctx, channelId: string, ms: number, alive?: () => Promise<unknown>): Promise<StreamView | null> {
  const until = Date.now() + ms;
  for (;;) {
    const list = await readStreams(ctx);
    const v = list?.find((s) => s.channelId === channelId);
    if (v?.state === 'failed') return null;
    if (v && v.lastSegmentAt !== null) return v;
    if (Date.now() >= until) return null;
    await alive?.();
    await sleep(POLL_MS);
  }
}

/** a stop that must not fail its caller (404 from an older livetv, livetv not answering: the 180-s safety net there ends it anyway) */
async function stopQuietly(ctx: Ctx, channelId: string): Promise<void> {
  await livetvCall(ctx, 'DELETE', `/v1/streams/${encodeURIComponent(channelId)}`, undefined, { timeoutMs: STOP_TIMEOUT_MS }).catch(() => undefined);
  invalidateLiveConversions();
}

const event = (ctx: Ctx, e: Parameters<typeof pushEvent>[1]) => pushEvent(ctx, e).catch(() => undefined);

/** what the push feed of a channel does now: receiving, or not (idle, unknown to livetv, no ingest endpoint); null = livetv not answering */
async function pushReceiving(ctx: Ctx, channelId: string): Promise<boolean | null> {
  try {
    const raw = await livetvCall<unknown>(ctx, 'GET', '/v1/ingest', undefined, { timeoutMs: LIST_TIMEOUT_MS });
    return Array.isArray(raw) && raw.some((x) => x && typeof x === 'object' && (x as Record<string, unknown>).channelId === channelId && (x as Record<string, unknown>).state === 'receiving');
  } catch (e) {
    if (e instanceof LivetvError) return e.status === 404 ? false : null;
    throw e;
  }
}

interface InputRow {
  ingest: Ingest; stream_kind: StreamKind; stream_url_enc: string | null; allow_lan: boolean | null; source_lan: boolean; user_agent: string | null;
  max_streams: number | null; enabled: boolean;
}

/** the channel's input for livetv: the decrypted URL (only for this signed call, F13) or the push feed by its channel id */
function inputOf(ctx: Ctx, channelId: string, r: InputRow): StreamInput | null {
  if (r.ingest === 'push') return { push: channelId };
  if (r.stream_url_enc === null) return null;
  const input: StreamInput = { url: decrypt(ctx.encKey, r.stream_url_enc), kind: r.stream_kind, allowLan: r.allow_lan ?? r.source_lan };
  if (r.user_agent) input.userAgent = r.user_agent;
  return input;
}

/**
 * Watches a channel: joins its running stream (no budget), or starts it (spec §7.4). Concurrent first viewers: one takes the start lock
 * `ltv:start:<channelId>` and starts it, the others wait for that stream and join it, so a household's race never costs a second
 * slot or a `live_full` (Review Focus 1). The answer's mode is what livetv reports once the first segment exists (its probe at start
 * can downgrade a transcode to remux).
 */
export async function startOrJoin(ctx: Ctx, who: Watcher, ch: EffectiveChannel, profile: LivetvProfile): Promise<{ streamKey: string; mode: Mode } | WatchError> {
  const unreachable = { status: 502, error: 'channel_unreachable' } as const;
  const until = Date.now() + JOIN_WAIT_MS;
  for (;;) {
    const list = await readStreams(ctx);
    if (list === null) return unreachable;
    const cur = activeOf(list, ch.id);
    if (cur) {
      await ctx.kv.set(joinKey(ch.id), '1', JOIN_MARK_TTL_S).catch(() => undefined);
      const joined = await join(ctx, cur);
      // join() may wait for the first segment as long as the marker lives: mark again so the tick sees the fresh viewer
      await ctx.kv.set(joinKey(ch.id), '1', JOIN_MARK_TTL_S).catch(() => undefined);
      return joined;
    }
    const token = randomUUID();
    if (await ctx.kv.setnx(startKey(ch.id), token, START_LOCK_TTL_S)) {
      try {
        return await start(ctx, who, ch, profile, list, token);
      } finally {
        await ctx.kv.delIfEquals(startKey(ch.id), token).catch(() => false);
      }
    }
    // somebody else starts it: wait for that stream and join it (or start it ourselves when that start gave up)
    if (Date.now() >= until) return unreachable;
    await sleep(POLL_MS);
  }
}

/** a running stream: its key and mode, once it has a first segment (a stream still starting is waited for, like a start) */
async function join(ctx: Ctx, v: StreamView): Promise<{ streamKey: string; mode: Mode } | WatchError> {
  if (v.lastSegmentAt !== null) return { streamKey: v.streamKey, mode: v.mode };
  const ready = await firstSegment(ctx, v.channelId, FIRST_SEGMENT_MS);
  if (ready) return { streamKey: ready.streamKey, mode: ready.mode };
  // still no segment: whoever started it decides its fate; a stream that is still listed is joined as it is
  const still = activeOf(await readStreams(ctx), v.channelId);
  return still ? { streamKey: still.streamKey, mode: still.mode } : { status: 502, error: 'channel_unreachable' };
}

async function start(ctx: Ctx, who: Watcher, ch: EffectiveChannel, profile: LivetvProfile, list: StreamView[], lock: string): Promise<{ streamKey: string; mode: Mode } | WatchError> {
  const unreachable = { status: 502, error: 'channel_unreachable' } as const;
  const user = { id: who.userId, role: who.role };
  const row = (await ctx.db.query<InputRow>(
    `select c.ingest, c.stream_kind, c.stream_url_enc, c.allow_lan, s.allow_lan as source_lan, s.user_agent, s.max_streams, s.enabled
       from livetv_channels c join livetv_sources s on s.id = c.source_id where c.id = $1`, [ch.id])).rows[0];
  if (!row || !row.enabled) return unreachable;

  if (row.ingest === 'push') {
    const receiving = await pushReceiving(ctx, ch.id);
    if (receiving === null) return unreachable;
    if (!receiving) return { status: 409, error: 'not_receiving' };
  }

  // the provider's connection limit (spec §19): the streams of this source that run now
  if (row.max_streams !== null) {
    const ids = list.filter((s) => s.state !== 'failed' && UUID_RE.test(s.channelId)).map((s) => s.channelId);
    const n = ids.length
      ? Number((await ctx.db.query<{ n: string }>('select count(*) as n from livetv_channels where source_id = $1 and id = any($2::uuid[])', [ch.sourceId, ids])).rows[0]?.n ?? 0)
      : 0;
    if (n >= row.max_streams) return { status: 503, error: 'provider_limit', max: row.max_streams, running: await runningList(ctx, user, profile, list) };
  }

  const input = inputOf(ctx, ch.id, row);
  if (!input) return unreachable;
  const mode = expectedMode(ch, Date.now());
  const key = convKey(ch.id);
  let granted = false;
  if (mode === 'transcode') {
    const a = await admitConversion(ctx, { kind: 'live', userId: who.userId, hint: key, label: ch.name });
    // 'unknown' = the budget lock or the media server's session list did not answer: not a full budget, so no full-event and a retry
    if (!a.ok && a.why === 'unknown') return unreachable;
    if (!a.ok) {
      await event(ctx, { level: 'warn', code: 'start_refused_full', channelId: ch.id });
      return { status: 503, error: 'live_full', running: await runningList(ctx, user, profile, list) };
    }
    // F8: the grant's play session is the key liveConversions lists, so the stream counts once whether livetv lists it yet or not
    await bindConvGrant(ctx, key, key, { label: ch.name });
    granted = true;
  }
  const giveBack = async () => {
    if (!granted) return;
    granted = false;
    await dropConvGrant(ctx, key);
  };

  try {
    const body: StartBody = {
      channelId: ch.id, input, mode, encoder: await liveEncoder(ctx), dvrSeconds: ctx.cfg.LIVETV_DVR_MINUTES * 60, maxBitrate: ctx.cfg.LIVETV_MAX_BITRATE,
    };
    // a slow admission (budget lock, encoder probe) must not let the lock lapse: a second starter would admit too. Lost = somebody else starts it
    if (!(await ctx.kv.refreshIfEquals(startKey(ch.id), lock, START_LOCK_TTL_S).catch(() => false))) {
      // the grant key is one per channel (F8): when another starter holds the lock now, it admitted under the same key, and
      // dropping it here would leave its stream uncounted. Only an orphaned grant (nobody holds the lock) is given back.
      if ((await ctx.kv.get(startKey(ch.id)).catch(() => 'unknown')) === null) await giveBack();
      return unreachable;
    }
    try {
      await livetvCall(ctx, 'POST', '/v1/streams', body, { timeoutMs: START_TIMEOUT_MS });
    } catch (e) {
      if (!(e instanceof LivetvError)) throw e;
      await giveBack();
      await event(ctx, { level: 'error', code: 'start_failed', channelId: ch.id, reason: e.code });
      return unreachable;
    }
    invalidateLiveConversions();
    // the lock covers the wait for the first segment too (a second watcher joins, never starts again)
    const ready = await firstSegment(ctx, ch.id, FIRST_SEGMENT_MS, () => ctx.kv.refreshIfEquals(startKey(ch.id), lock, START_LOCK_TTL_S).catch(() => false));
    if (!ready) {
      await stopQuietly(ctx, ch.id);
      await giveBack();
      await event(ctx, { level: 'error', code: 'start_failed', channelId: ch.id, reason: 'no_segment' });
      return unreachable;
    }
    // livetv's own probe at start decides the real mode (a transcode becomes remux): only a transcode keeps the slot
    if (ready.mode !== 'transcode') await giveBack();
    return { streamKey: ready.streamKey, mode: ready.mode };
  } catch (e) {
    await giveBack();
    throw e;
  }
}

// ---- livetvTick ----

/** livetv restarted (its bootId changed): it lost the push set, send it again (spec §3.5) */
async function bootCheck(ctx: Ctx): Promise<void> {
  const st = await detectLivetv(ctx, BOOT_MAX_AGE_MS);
  if (!st.installed || !st.bootId) return;
  if ((await ctx.kv.get(BOOT_KEY)) === st.bootId) return;
  await syncIngest(ctx); // never throws; a failed sync leaves the dirty flag livetvIngestTick retries
  await ctx.kv.set(BOOT_KEY, st.bootId, BOOT_TTL_S);
}

/** refused push attempts (wrong stream id or passphrase): one `push_rejected` per feed per 10 min, with the hour's count */
async function rejectedNotes(ctx: Ctx): Promise<void> {
  let raw: unknown;
  try { raw = await livetvCall<unknown>(ctx, 'GET', '/v1/ingest', undefined, { timeoutMs: LIST_TIMEOUT_MS }); } catch { return; }
  if (!Array.isArray(raw)) return;
  for (const x of raw.slice(0, MAX_ITEMS)) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    const n = num(o?.rejected1h);
    if (!o || typeof o.channelId !== 'string' || !UUID_RE.test(o.channelId) || n === null || n <= 0) continue;
    if (await ctx.kv.setnx(rejectKey(o.channelId), '1', REJECT_NOTE_TTL_S)) {
      await event(ctx, { level: 'warn', code: 'push_rejected', channelId: o.channelId, n: Math.min(Math.floor(n), 1_000_000) });
    }
  }
}

/** livetv's input events of a stream the tick has not reported yet (`input_lost`, `input_back` with the outage in seconds) */
async function streamEvents(ctx: Ctx, s: StreamView): Promise<void> {
  if (!s.errors.length || !UUID_RE.test(s.channelId)) return;
  const seen = Number(await ctx.kv.get(errSeenKey(s.channelId))) || 0;
  const fresh = s.errors.filter((e) => e.at > seen).sort((a, b) => a.at - b.at);
  if (!fresh.length) return;
  for (const e of fresh) {
    await event(ctx, {
      level: e.code === 'input_lost' ? 'warn' : 'info', code: e.code, channelId: s.channelId, ...(e.seconds !== undefined ? { n: Math.round(e.seconds) } : {}),
    });
  }
  await ctx.kv.set(errSeenKey(s.channelId), String(fresh[fresh.length - 1]!.at), ERR_SEEN_TTL_S);
}

/**
 * Every 15 s (server.ts, behind op()), one runner at a time (`ltv:tick`): re-sends the push set after a livetv restart, notes refused
 * push attempts and new input events, and stops every stream whose viewer count has been 0 for 60 s (`ltv:zero:<id>` holds since when;
 * a stream nobody watched since this backend started has no viewer key either, so it stops the same way). A stream still being
 * started is left alone. No recording uses a channel in Phase 1 (recordings arrive with Phase 3).
 */
export async function livetvTick(ctx: Ctx): Promise<void> {
  if (!livetvInstalled(ctx)) return;
  const token = randomUUID();
  if (!(await ctx.kv.setnx(TICK_KEY, token, TICK_LOCK_TTL_S))) return;
  try {
    const renew = () => ctx.kv.refreshIfEquals(TICK_KEY, token, TICK_LOCK_TTL_S).catch(() => false);
    await bootCheck(ctx);
    if (!(await renew())) return;
    await rejectedNotes(ctx);
    if (!(await renew())) return;
    const list = await readStreams(ctx);
    if (!list) return;
    const viewers = await viewerCounts(ctx);
    const now = Date.now();
    for (const s of list) {
      if (!(await renew())) return;
      const id = s.channelId;
      await streamEvents(ctx, s);
      if (await ctx.kv.get(startKey(id))) continue;
      if ((viewers.get(id) ?? 0) > 0) {
        await ctx.kv.del(zeroKey(id));
        continue;
      }
      const since = Number(await ctx.kv.get(zeroKey(id)));
      if (!since) {
        await ctx.kv.set(zeroKey(id), String(now), ZERO_TTL_S);
        continue;
      }
      if (now - since < STOP_AFTER_MS) continue;
      // a watch that joined after the snapshot above must keep its stream: under the channel's start lock (no start runs meanwhile) look
      // at the viewers and the join marker again right before the stop
      const lock = randomUUID();
      if (!(await ctx.kv.setnx(startKey(id), lock, START_LOCK_TTL_S))) continue;
      try {
        if ((await viewerCounts(ctx)).get(id) || (await ctx.kv.get(joinKey(id)))) {
          await ctx.kv.del(zeroKey(id));
          continue;
        }
        await stopQuietly(ctx, id);
        await dropConvGrant(ctx, convKey(id));
        await ctx.kv.del(zeroKey(id));
      } finally {
        await ctx.kv.delIfEquals(startKey(id), lock).catch(() => false);
      }
    }
  } finally {
    await ctx.kv.delIfEquals(TICK_KEY, token).catch(() => false);
  }
}

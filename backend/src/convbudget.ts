// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { CONV_DL_PREFIX, CONV_EXEMPT_PREFIX, within, type DownloadMark, type SessionRead } from './convexempt.js';
import { HEVC_SESSIONS_TIMEOUT_MS, fingerprint } from './hevcenc.js';
import { listLive } from './live.js';
import type { EncoderSettings, ServerSession } from './media/types.js';

/**
 * One budget for every video conversion on the server: films and series (any app's media server sessions plus grants not listed
 * yet), download preparation, and later live TV, recordings and re-encodes (spec §5). New conversions are admitted by limit and
 * priority (admits); running conversions are never stopped here, whoever started them. Grants, exempt marks and the lock live in KV
 * and carry only kinds, ids and a display label; no URL, token or path.
 */
/**
 * The live TV transcodes livetv runs, registered by livetv/streams.ts when it loads (no import back: convbudget is a leaf of that
 * graph, so no load order can reach a half-initialised module). Without a registration there are none.
 */
export type LiveSource = (ctx: Ctx) => Promise<ConvEntry[]>;
let liveSource: LiveSource = async () => [];
export function setLiveSource(fn: LiveSource): void {
  liveSource = fn;
}

export type ConvKind = 'film' | 'live' | 'record' | 'download' | 'reencode';
export type ConvPriority = 'films' | 'live' | 'equal';
export interface ConvEntry {
  kind: ConvKind;
  /** the play session (or `grant:<hint>` for a grant not bound yet, `anon:<n>` for a server session without one) */
  key: string;
  hevc?: true;
  /** title (a series by its series name) or channel name */
  label: string | null;
  since: number | null;
  /** the FriendFlix device id where known (portal stream, grant); null for other apps */
  device: string | null;
  userId: string | null;
  /** a grant whose conversion the media server does not list yet */
  pending?: true;
}
/** a timed conversion benchmark (conv:bench = the media server; conv:bench:livetv: hwAccel holds the encoder name) */
export interface BenchRecord { speed: number; hwAccel: string; fingerprint: string; at: number }

export const CONV_DEFAULT_SLOTS = 2;
export const CONV_GRANT_TTL_S = 30;
export { CONV_EXEMPT_TTL_S, markConvExempt, sharedSessionRead, type SessionRead } from './convexempt.js';

const LOCK_KEY = 'conv:gate';
const LOCK_TTL_S = 3;
/** a second asker waits for the lock in short steps up to about 1 s (a holder's critical section is bounded by the 800-ms session read) */
const LOCK_STEP_MS = 100;
const LOCK_WAIT_MS = 1000;
const GRANT = 'conv:grant:';
/**
 * The ids of the grant keys (conv:grant:<id>) in one KV index (a sorted set by expiry), kept by admit / bind / drop, so an admission under the
 * lock reads O(grants), never the keyspace. A member lives 1 s longer than its 30-s grant; a member whose grant is gone reads as null.
 */
const GRANT_INDEX = 'conv:grants';
const INDEX_TTL_S = CONV_GRANT_TTL_S + 1;
/** the record /api/playback/info and cast write per play session (`conv`: that answer really converts, ruling 6) */
const PBINFO = 'pbinfo:';
const BENCH_KEY = 'conv:bench';
const BENCH_LIVETV_KEY = 'conv:bench:livetv';
const SETTINGS_MEMO_MS = 60_000;
const SETTINGS_TIMEOUT_MS = 3000;
/** recommendation = 70 % of the measured speed (30 % safety margin) */
const SAFETY = 0.7;
const MAX_SLOTS = 16;

/** `swap`: a hover / focus prefetch grant of /api/playback/info: the same device's next prefetch grant replaces it while no stream uses it */
interface Grant { kind: ConvKind; user: string; device?: string; hevc?: true; label?: string; ps?: string; swap?: true }

/** 1 slot kept free for the preferred kind once there are 2 slots or more; none when both rank equal */
export const holdback = (limit: number, p: ConvPriority): 0 | 1 => (limit >= 2 && p !== 'equal' ? 1 : 0);

/**
 * May one more conversion of `kind` start while `used` run under `limit`? Spec §5.2 with ruling 10: a recording at its start and the
 * preferred one of film/live up to the limit, the other one up to limit - holdback, downloads and re-encodes only while at most
 * max(1, L - H - 1) - 1 run (they wait, so they run when nothing else converts even at L = 1).
 */
export function admits(kind: ConvKind, used: number, limit: number, p: ConvPriority): boolean {
  const h = holdback(limit, p);
  if (kind === 'record') return used < limit;
  if (kind === 'download' || kind === 'reencode') return used < Math.max(1, limit - h - 1);
  const preferred = p === 'equal' || (p === 'films' ? kind === 'film' : kind === 'live');
  return used < (preferred ? limit : limit - h);
}

/** clamp(floor(min(speeds) x 0.7), 1, 16) (spec §5.3) */
export function recommend(s: { jellyfin: number; livetv?: number }): number {
  const speeds = [s.jellyfin, s.livetv].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const min = speeds.length ? Math.min(...speeds) : 0;
  return Math.min(MAX_SLOTS, Math.max(1, Math.floor(min * SAFETY))); // exact for every speed with up to 3 decimals (no epsilon needed)
}

const parse = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};
const benchOf = (raw: string | null): BenchRecord | null => {
  const b = parse<Partial<BenchRecord>>(raw);
  return b && typeof b.speed === 'number' && Number.isFinite(b.speed) && b.speed > 0 && typeof b.hwAccel === 'string' && typeof b.fingerprint === 'string' && typeof b.at === 'number'
    ? { speed: b.speed, hwAccel: b.hwAccel, fingerprint: b.fingerprint, at: b.at } : null;
};

/**
 * The media server's encoder settings, read at most once a minute per media server instance (a failed read is remembered too). One
 * read runs at a time for up to 3 s; each caller waits at most `waitMs` for it (late = null) while the read goes on and fills the memo.
 */
let settingsMemo = new WeakMap<object, { at: number; p: Promise<EncoderSettings | null> }>();
/** tests only: forget every memoised settings read */
export const __resetConvMemo = (): void => { settingsMemo = new WeakMap(); };
async function encoderSettings(ctx: Ctx, waitMs: number): Promise<EncoderSettings | null> {
  const jf = ctx.jf;
  let hit = settingsMemo.get(jf);
  if (!hit || Date.now() - hit.at >= SETTINGS_MEMO_MS) {
    const read = jf.admin.encoderSettings?.bind(jf.admin);
    hit = { at: Date.now(), p: read ? within(read, SETTINGS_TIMEOUT_MS).then((v) => v ?? null) : Promise.resolve(null) };
    settingsMemo.set(jf, hit);
  }
  const p = hit.p;
  return waitMs >= SETTINGS_TIMEOUT_MS ? p : ((await within(() => p, waitMs)) ?? null);
}

/**
 * Whether livetv's stored record measured another encoder than the one it would use now (LIVETV_ENCODER against what livetv can use),
 * registered by convbench.ts when it loads (no import back, as for the live source). Without a registration a record is never stale.
 * `jfHwAccel`: the media server's hardware acceleration the `auto` choice follows.
 */
export type LivetvEncoderCheck = (ctx: Ctx, rec: BenchRecord, jfHwAccel: string | null) => Promise<boolean>;
let livetvEncoderChanged: LivetvEncoderCheck = async () => false;
export function setLivetvEncoderCheck(fn: LivetvEncoderCheck): void {
  livetvEncoderChanged = fn;
}

/**
 * Both benchmark records; `stale` when the media server's encoder settings changed since its record, `livetvStale` when livetv's
 * record measured another encoder than the configured one (then automatic falls back to 2 until it is measured again). Unreadable or
 * late settings are not stale. `settingsMs`: how long to wait for the settings (admin views 3 s; the admission path 800 ms, never a
 * slow start).
 */
export async function readBench(ctx: Ctx, settingsMs = SETTINGS_TIMEOUT_MS): Promise<{ jellyfin: BenchRecord | null; livetv: BenchRecord | null; stale: boolean; livetvStale: boolean }> {
  const [jf, lt] = await ctx.kv.mget([BENCH_KEY, BENCH_LIVETV_KEY]).catch(() => [null, null]);
  const jellyfin = benchOf(jf ?? null);
  const livetv = benchOf(lt ?? null);
  if (!jellyfin && !livetv) return { jellyfin, livetv, stale: false, livetvStale: false };
  const settings = await encoderSettings(ctx, settingsMs);
  const changed = livetv && settings !== null ? await within(() => livetvEncoderChanged(ctx, livetv, settings.hwAccel ?? null).catch(() => false), settingsMs) : false;
  return { jellyfin, livetv, stale: jellyfin !== null && settings !== null && jellyfin.fingerprint !== fingerprint(settings), livetvStale: changed === true };
}

/**
 * The limit in force: the admin's CONVERSION_SLOTS, else automatic = the recommendation of a current benchmark, else 2.
 * `recommended` is null while nothing (current) is measured.
 */
export async function conversionLimit(ctx: Ctx, o: { settingsMs?: number } = {}): Promise<{ limit: number; auto: number; custom: number | null; recommended: number | null; priority: ConvPriority }> {
  const { CONVERSION_SLOTS, CONVERSION_PRIORITY } = ctx.cfg;
  const b = await readBench(ctx, o.settingsMs);
  const recommended = b.jellyfin && !b.stale && !b.livetvStale ? recommend({ jellyfin: b.jellyfin.speed, ...(b.livetv ? { livetv: b.livetv.speed } : {}) }) : null;
  const auto = recommended ?? CONV_DEFAULT_SLOTS;
  const custom = CONVERSION_SLOTS ?? null;
  return { limit: custom ?? auto, auto, custom, recommended, priority: CONVERSION_PRIORITY };
}

/** the server converts this session's picture (or does not say and transcodes: counted, fail-safe) */
const converts = (s: ServerSession) => s.videoDirect === false || (s.videoDirect === undefined && s.playMethod === 'Transcode');
/** the server says what it does with this play session (its own entry counts, or not) */
const decided = (s: ServerSession | undefined) => Boolean(s && (s.videoDirect !== undefined || s.playMethod === 'Transcode'));

/**
 * What converts now, one entry per play session: the media server's converting sessions (any app; preview clips, the HEVC probe and
 * the benchmark are exempt; a preparing download's session counts as `download`), plus running download preparations from their own
 * job state (`conv:dl:<job>`, convexempt.ts; once per play session, whether the server lists it or not), plus grants whose session the
 * server does not list yet, plus live TV transcodes (`live:<channelId>`, livetv/streams.ts liveConversions), plus portal streams the server does not list whose pbinfo record says they convert (two devices of one profile share one
 * server session, so the server's list alone can undercount, as in hevcGate). With exceptUser + exceptDevice that device's own streams
 * and grants are left out (its new stream replaces them, as in hevcGate). null: the session list did not answer within 800 ms
 * (unknown). A server without a session list counts grants and portal records only. `sessions`: a request's shared read. `exceptLive`:
 * a live channel left out (its entry `live:<id>`, listed by livetv or a grant bound to that key): the stream a channel switch releases
 * (ruling 37, Task 32).
 */
export async function countConversions(ctx: Ctx, o: { exceptUser?: string; exceptDevice?: string; exceptLive?: string; sessions?: SessionRead | null } = {}): Promise<ConvEntry[] | null> {
  const entries = (await count(ctx, o))?.entries ?? null;
  return entries && o.exceptLive !== undefined ? withoutLive(entries, o.exceptLive) : entries;
}
/** the entries without the live channel's own (`live:<channelId>`: livetv's listing and the grant bound to that key share it, F8) */
const withoutLive = (entries: ConvEntry[], channelId: string) => entries.filter((e) => e.key !== `live:${channelId}`);

/**
 * countConversions plus `ownPending`: the excepted device's prefetch grants (`swap`) that no stream uses yet (the server does not say
 * what it does with their play session and no live record plays it: a hover / focus prefetch, an answer nobody took). A cast or download
 * grant is never among them (a cast's stream plays on the receiver, which reports later).
 */
async function count(ctx: Ctx, o: { exceptUser?: string; exceptDevice?: string; sessions?: SessionRead | null }): Promise<{ entries: ConvEntry[]; ownPending: string[] } | null> {
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  const sessions = list ? await (o.sessions ?? (() => within(list, HEVC_SESSIONS_TIMEOUT_MS)))() : [];
  if (!sessions) return null;
  const [live, liveTv] = await Promise.all([listLive(ctx).catch(() => []), liveSource(ctx).catch(() => [] as ConvEntry[])]);
  const liveBy = new Map(live.map((l) => [l.playSessionId, l] as const));
  const bySession = new Map(sessions.flatMap((s) => (s.playSessionId ? [[s.playSessionId, s] as const] : [])));

  const candidates = sessions.flatMap((s, i) => (converts(s) ? [{ s, key: s.playSessionId ?? `anon:${i}` }] : []));
  const withPs = candidates.flatMap((c) => (c.s.playSessionId ? [c.s.playSessionId] : []));
  const exempt = new Set<string>();
  // preparing downloads: their play session (a listed one counts as `download`) and their own running mark, in one mget with the exempt marks
  const jobs = (await ctx.db.query<{ id: string; play_session_id: string | null }>("select id, play_session_id from download_jobs where status = 'preparing'")
    .catch(() => ({ rows: [] as Array<{ id: string; play_session_id: string | null }> }))).rows;
  const downloads = new Set(jobs.flatMap((r) => (r.play_session_id ? [r.play_session_id] : [])));
  const markKeys = [...withPs.map((ps) => `${CONV_EXEMPT_PREFIX}${ps}`), ...jobs.map((r) => `${CONV_DL_PREFIX}${r.id}`)];
  const marks = markKeys.length ? await ctx.kv.mget(markKeys).catch(() => [] as Array<string | null>) : [];
  withPs.forEach((ps, i) => { if (marks[i] != null) exempt.add(ps); });
  const running = jobs.flatMap((r, i) => {
    const m = parse<DownloadMark>(marks[withPs.length + i]);
    return m && typeof m.ps === 'string' ? [{ job: r.id, ...m }] : [];
  });

  const out = new Map<string, ConvEntry>();
  for (const { s, key } of candidates) {
    if (exempt.has(key) || out.has(key)) continue;
    const l = liveBy.get(key);
    const kind: ConvKind = downloads.has(key) ? 'download' : 'film';
    out.set(key, {
      kind, key, ...(kind === 'film' && s.videoCodec === 'hevc' ? { hevc: true as const } : {}),
      label: s.item.seriesName || s.item.name || null, since: null, device: l?.deviceId ?? null, userId: l?.userId ?? null,
    });
  }

  // a running download preparation counts from its own state when the server does not say what its session does (not listed)
  for (const d of running) {
    const key = d.ps || `dl:${d.job}`;
    if (out.has(key) || exempt.has(key) || decided(bySession.get(key))) continue;
    out.set(key, { kind: 'download', key, label: d.label ?? null, since: null, device: null, userId: d.user ?? null });
  }

  // live TV transcodes livetv runs (Task 31), before the grants: a start's grant is bound to the same key `live:<channelId>`, so the
  // grant loop skips it once livetv lists the stream (one entry per key, F8)
  for (const e of liveTv) if (!out.has(e.key)) out.set(e.key, e);

  const mine = o.exceptUser !== undefined && o.exceptDevice !== undefined;
  const ownPending: string[] = [];
  const grantKeys = (await ctx.kv.indexMembers(GRANT_INDEX).catch(() => [] as string[])).map((id) => `${GRANT}${id}`);
  const grants = grantKeys.length ? await ctx.kv.mget(grantKeys).catch(() => [] as Array<string | null>) : [];
  grantKeys.forEach((k, i) => {
    const g = parse<Grant>(grants[i]);
    if (!g || typeof g.kind !== 'string') return;
    if (mine && g.user === o.exceptUser && g.device === o.exceptDevice) { // this device's earlier grant is replaced
      if (g.swap && (!g.ps || (!decided(bySession.get(g.ps)) && !liveBy.has(g.ps)))) ownPending.push(k);
      return;
    }
    if (g.ps && decided(bySession.get(g.ps))) return; // the server says what it does: its own entry counts (or not)
    const key = g.ps ?? `grant:${k.slice(GRANT.length)}`;
    if (out.has(key) || exempt.has(key)) return;
    out.set(key, {
      kind: g.kind, key, ...(g.hevc ? { hevc: true as const } : {}), label: g.label ?? null, since: null, device: g.device ?? null, userId: g.user ?? null, pending: true,
    });
  });

  // portal streams the server does not list (yet, or behind another device's play session in the one session of their profile)
  const unlisted = live.filter((l) => !out.has(l.playSessionId) && !exempt.has(l.playSessionId) && !decided(bySession.get(l.playSessionId)));
  if (unlisted.length) {
    const recs = await ctx.kv.mget(unlisted.map((l) => `${PBINFO}${l.userId}:${l.playSessionId}`)).catch(() => [] as Array<string | null>);
    unlisted.forEach((l, i) => {
      const r = parse<{ conv?: unknown; video?: unknown }>(recs[i]);
      if (r?.conv !== true || out.has(l.playSessionId)) return; // `video` alone also describes direct-play answers: only `conv` counts
      out.set(l.playSessionId, {
        kind: 'film', key: l.playSessionId, ...(r.video === 'hevc' ? { hevc: true as const } : {}), label: l.seriesName || l.title || null, since: null, device: l.deviceId ?? null, userId: l.userId,
      });
    });
  }

  if (mine) for (const l of live) if (l.userId === o.exceptUser && l.deviceId === o.exceptDevice) out.delete(l.playSessionId);
  return { entries: [...out.values()], ownPending };
}

/**
 * May this conversion start? One asker at a time (KV lock, waited for in 100-ms steps up to about 1 s), count without the asker's own
 * device, apply the priority rule, then write a 30-s grant under `hint` (bindConvGrant moves it to the real play session). With `swap`
 * (a hover / focus prefetch of /api/playback/info) the device's own pending swap grants go with it: its new
 * grant replaces them, so a browsing device holds at most one slot, never one per hover, and other devices are not refused because of
 * them. Every media
 * server read on this path is bounded by 800 ms (settings and sessions run in parallel), so the answer comes within about 2 s at worst.
 * `unknown`: the lock or the session list could not be had in time; the caller treats it like `full` (a download waits for its next tick).
 * `exceptLive` (a channel switch, ruling 37): the live channel the switch would release is left out of the count; `onlyWithout` says the
 * admission passed only because of that (the same count with it would refuse). Both counts are decided here, under the one lock, so no
 * other admission sees the slot in between; the caller must then release that channel or drop this grant.
 */
export async function admitConversion(ctx: Ctx, o: { kind: ConvKind; userId: string; deviceId?: string; hint: string; hevc?: boolean; label?: string; swap?: boolean; sessions?: SessionRead | null; exceptLive?: string }): Promise<{ ok: true; onlyWithout?: true } | { ok: false; why: 'full' | 'unknown' }> {
  // the limit does not depend on the lock: its settings read (800 ms at most here) starts now and overlaps the wait and the count
  const limP = conversionLimit(ctx, { settingsMs: HEVC_SESSIONS_TIMEOUT_MS });
  limP.catch(() => undefined); // awaited below; never an unhandled rejection when the lock is not had
  const token = randomUUID();
  const until = Date.now() + LOCK_WAIT_MS;
  let locked = await ctx.kv.setnx(LOCK_KEY, token, LOCK_TTL_S).catch(() => false);
  while (!locked && Date.now() < until) {
    await new Promise((r) => setTimeout(r, LOCK_STEP_MS));
    locked = await ctx.kv.setnx(LOCK_KEY, token, LOCK_TTL_S).catch(() => false);
  }
  if (!locked) return { ok: false, why: 'unknown' };
  try {
    const [lim, counted] = await Promise.all([limP, count(ctx, { ...(o.deviceId ? { exceptUser: o.userId, exceptDevice: o.deviceId } : {}), ...(o.sessions ? { sessions: o.sessions } : {}) })]);
    if (!counted) return { ok: false, why: 'unknown' };
    const withIt = admits(o.kind, counted.entries.length, lim.limit, lim.priority);
    const onlyWithout = !withIt && o.exceptLive !== undefined && admits(o.kind, withoutLive(counted.entries, o.exceptLive).length, lim.limit, lim.priority);
    if (!withIt && !onlyWithout) return { ok: false, why: 'full' };
    const g: Grant = { kind: o.kind, user: o.userId, ...(o.deviceId ? { device: o.deviceId } : {}), ...(o.hevc ? { hevc: true as const } : {}), ...(o.label ? { label: o.label } : {}), ...(o.swap && o.deviceId ? { swap: true as const } : {}) };
    const key = `${GRANT}${o.hint}`;
    // indexed first: a grant is never written where the count cannot see it (a failed write leaves a member without a grant: nothing)
    const written = await ctx.kv.indexAdd(GRANT_INDEX, o.hint, INDEX_TTL_S).then(() => ctx.kv.set(key, JSON.stringify(g), CONV_GRANT_TTL_S)).then(() => true, () => false);
    if (!written) return { ok: false, why: 'unknown' };
    // the new grant is in: the device's own pending ones are replaced (a failed delete leaves one to its TTL, the safe direction)
    if (o.swap) await Promise.all(counted.ownPending.filter((k) => k !== key).map((k) => removeGrant(ctx, k.slice(GRANT.length))));
    return onlyWithout ? { ok: true, onlyWithout: true } : { ok: true };
  } finally {
    await ctx.kv.delIfEquals(LOCK_KEY, token).catch(() => undefined);
  }
}

/**
 * After the media server answered: the grant written for `hint` now belongs to the real play session (null: no conversion, dropped).
 * `hevc` / `label`: what the answer turned out to be (an HEVC plan refused by the HEVC gate converts H.264; the title is known late).
 */
export async function bindConvGrant(ctx: Ctx, hint: string, playSessionId: string | null, o: { hevc?: boolean; label?: string } = {}): Promise<void> {
  const raw = await ctx.kv.get(`${GRANT}${hint}`).catch(() => null);
  if (raw === null) return;
  const g = parse<Grant>(raw);
  if (playSessionId && g) {
    const moved: Grant = { ...g, ...(o.label ? { label: o.label } : {}), ps: playSessionId };
    if (o.hevc === true) moved.hevc = true;
    else if (o.hevc === false) delete moved.hevc;
    // the new key first (indexed, then written): a count between the writes sees this grant under both keys (one slot too many for a
    // moment, safe). When the new key cannot be indexed or written the hint key stays, so the grant still counts until its TTL ends.
    const written = await ctx.kv.indexAdd(GRANT_INDEX, playSessionId, INDEX_TTL_S)
      .then(() => ctx.kv.set(`${GRANT}${playSessionId}`, JSON.stringify(moved), CONV_GRANT_TTL_S)).then(() => true, () => false);
    if (!written) return;
  }
  if (hint !== playSessionId) await removeGrant(ctx, hint);
}
/** a grant and its index entry go (never throws; a member left behind reads as null and expires with its TTL) */
const removeGrant = async (ctx: Ctx, id: string): Promise<void> => {
  await ctx.kv.del(`${GRANT}${id}`).catch(() => undefined);
  await ctx.kv.indexRemove(GRANT_INDEX, id).catch(() => undefined);
};
export const dropConvGrant = (ctx: Ctx, hint: string) => bindConvGrant(ctx, hint, null);

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { CONV_EXEMPT_PREFIX, within } from './convexempt.js';
import { HEVC_SESSIONS_TIMEOUT_MS, fingerprint } from './hevcenc.js';
import { listLive } from './live.js';
import type { EncoderSettings, ServerSession } from './media/types.js';

/**
 * One budget for every video conversion on the server: films and series (any app's media server sessions plus grants not listed
 * yet), download preparation, and later live TV, recordings and re-encodes (spec §5). New conversions are admitted by limit and
 * priority (admits); running conversions are never stopped here, whoever started them. Grants, exempt marks and the lock live in KV
 * and carry only kinds, ids and a display label; no URL, token or path.
 */
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
export { CONV_EXEMPT_TTL_S, markConvExempt } from './convexempt.js';

const LOCK_KEY = 'conv:gate';
const LOCK_TTL_S = 3;
/** a second asker waits for the lock in short steps up to about 1 s (a holder's critical section is bounded by the 800-ms session read) */
const LOCK_STEP_MS = 100;
const LOCK_WAIT_MS = 1000;
const GRANT = 'conv:grant:';
const BENCH_KEY = 'conv:bench';
const BENCH_LIVETV_KEY = 'conv:bench:livetv';
const SETTINGS_MEMO_MS = 60_000;
const SETTINGS_TIMEOUT_MS = 3000;
/** recommendation = 70 % of the measured speed (30 % safety margin) */
const SAFETY = 0.7;
const MAX_SLOTS = 16;

interface Grant { kind: ConvKind; user: string; device?: string; hevc?: true; label?: string; ps?: string }

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
 * Both benchmark records; `stale` when the media server's encoder settings changed since its record. Unreadable or late settings are
 * not stale. `settingsMs`: how long to wait for the settings (admin views 3 s; the admission path 800 ms, never a slow start).
 */
export async function readBench(ctx: Ctx, settingsMs = SETTINGS_TIMEOUT_MS): Promise<{ jellyfin: BenchRecord | null; livetv: BenchRecord | null; stale: boolean }> {
  const [jf, lt] = await ctx.kv.mget([BENCH_KEY, BENCH_LIVETV_KEY]).catch(() => [null, null]);
  const jellyfin = benchOf(jf ?? null);
  const livetv = benchOf(lt ?? null);
  if (!jellyfin) return { jellyfin, livetv, stale: false };
  const settings = await encoderSettings(ctx, settingsMs);
  return { jellyfin, livetv, stale: settings !== null && jellyfin.fingerprint !== fingerprint(settings) };
}

/**
 * The limit in force: the admin's CONVERSION_SLOTS, else automatic = the recommendation of a current benchmark, else 2.
 * `recommended` is null while nothing (current) is measured.
 */
export async function conversionLimit(ctx: Ctx, o: { settingsMs?: number } = {}): Promise<{ limit: number; auto: number; custom: number | null; recommended: number | null; priority: ConvPriority }> {
  const { CONVERSION_SLOTS, CONVERSION_PRIORITY } = ctx.cfg;
  const b = await readBench(ctx, o.settingsMs);
  const recommended = b.jellyfin && !b.stale ? recommend({ jellyfin: b.jellyfin.speed, ...(b.livetv ? { livetv: b.livetv.speed } : {}) }) : null;
  const auto = recommended ?? CONV_DEFAULT_SLOTS;
  const custom = CONVERSION_SLOTS ?? null;
  return { limit: custom ?? auto, auto, custom, recommended, priority: CONVERSION_PRIORITY };
}

/** the server converts this session's picture (or does not say and transcodes: counted, fail-safe) */
const converts = (s: ServerSession) => s.videoDirect === false || (s.videoDirect === undefined && s.playMethod === 'Transcode');

/**
 * What converts now, one entry per play session: the media server's converting sessions (any app; preview clips, the HEVC probe and
 * the benchmark are exempt; a preparing download's session counts as `download`), plus grants whose session the server does not list
 * yet. With exceptUser + exceptDevice that device's own streams and grants are left out (its new stream replaces them, as in hevcGate).
 * null: the session list did not answer within 800 ms (unknown). A server without a session list counts grants only.
 */
export async function countConversions(ctx: Ctx, o: { exceptUser?: string; exceptDevice?: string } = {}): Promise<ConvEntry[] | null> {
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  const sessions = list ? await within(list, HEVC_SESSIONS_TIMEOUT_MS) : [];
  if (!sessions) return null;
  const live = await listLive(ctx).catch(() => []);
  const liveBy = new Map(live.map((l) => [l.playSessionId, l] as const));
  const bySession = new Map(sessions.flatMap((s) => (s.playSessionId ? [[s.playSessionId, s] as const] : [])));

  const candidates = sessions.flatMap((s, i) => (converts(s) ? [{ s, key: s.playSessionId ?? `anon:${i}` }] : []));
  const withPs = candidates.flatMap((c) => (c.s.playSessionId ? [c.s.playSessionId] : []));
  const exempt = new Set<string>();
  const downloads = new Set<string>();
  if (withPs.length) {
    const marks = await ctx.kv.mget(withPs.map((ps) => `${CONV_EXEMPT_PREFIX}${ps}`)).catch(() => [] as Array<string | null>);
    withPs.forEach((ps, i) => { if (marks[i] != null) exempt.add(ps); });
    const rows = await ctx.db.query<{ play_session_id: string }>(
      "select play_session_id from download_jobs where status = 'preparing' and play_session_id = any($1::text[])", [withPs],
    ).catch(() => ({ rows: [] as Array<{ play_session_id: string }> }));
    for (const r of rows.rows) downloads.add(r.play_session_id);
  }

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

  const mine = o.exceptUser !== undefined && o.exceptDevice !== undefined;
  const grantKeys = await ctx.kv.keys(GRANT).catch(() => [] as string[]);
  const grants = grantKeys.length ? await ctx.kv.mget(grantKeys).catch(() => [] as Array<string | null>) : [];
  grantKeys.forEach((k, i) => {
    const g = parse<Grant>(grants[i]);
    if (!g || typeof g.kind !== 'string') return;
    if (mine && g.user === o.exceptUser && g.device === o.exceptDevice) return; // this device's earlier grant is replaced
    const listed = g.ps ? bySession.get(g.ps) : undefined;
    if (listed && (listed.videoDirect !== undefined || listed.playMethod === 'Transcode')) return; // the server says what it does: its own entry counts (or not)
    const key = g.ps ?? `grant:${k.slice(GRANT.length)}`;
    if (out.has(key) || exempt.has(key)) return;
    out.set(key, {
      kind: g.kind, key, ...(g.hevc ? { hevc: true as const } : {}), label: g.label ?? null, since: null, device: g.device ?? null, userId: g.user ?? null, pending: true,
    });
  });

  if (mine) for (const l of live) if (l.userId === o.exceptUser && l.deviceId === o.exceptDevice) out.delete(l.playSessionId);
  return [...out.values()];
}

/**
 * May this conversion start? One asker at a time (KV lock, waited for in 100-ms steps up to about 1 s), count without the asker's own
 * device, apply the priority rule, then write a 30-s grant under `hint` (bindConvGrant moves it to the real play session). Every media
 * server read on this path is bounded by 800 ms (settings and sessions run in parallel), so the answer comes within about 2 s at worst.
 * `unknown`: the lock or the session list could not be had in time; the caller treats it like `full` (a download waits for its next tick).
 */
export async function admitConversion(ctx: Ctx, o: { kind: ConvKind; userId: string; deviceId?: string; hint: string; hevc?: boolean; label?: string }): Promise<{ ok: true } | { ok: false; why: 'full' | 'unknown' }> {
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
    const [lim, running] = await Promise.all([limP, countConversions(ctx, o.deviceId ? { exceptUser: o.userId, exceptDevice: o.deviceId } : {})]);
    if (!running) return { ok: false, why: 'unknown' };
    if (!admits(o.kind, running.length, lim.limit, lim.priority)) return { ok: false, why: 'full' };
    const g: Grant = { kind: o.kind, user: o.userId, ...(o.deviceId ? { device: o.deviceId } : {}), ...(o.hevc ? { hevc: true as const } : {}), ...(o.label ? { label: o.label } : {}) };
    const written = await ctx.kv.set(`${GRANT}${o.hint}`, JSON.stringify(g), CONV_GRANT_TTL_S).then(() => true, () => false);
    return written ? { ok: true } : { ok: false, why: 'unknown' };
  } finally {
    await ctx.kv.delIfEquals(LOCK_KEY, token).catch(() => undefined);
  }
}

/** After the media server answered: the grant written for `hint` now belongs to the real play session (null: no conversion, dropped). */
export async function bindConvGrant(ctx: Ctx, hint: string, playSessionId: string | null): Promise<void> {
  const raw = await ctx.kv.get(`${GRANT}${hint}`).catch(() => null);
  if (raw === null) return;
  const g = parse<Grant>(raw);
  // the new key first: a count in between sees the grant twice (safe), never not at all
  if (playSessionId && g) await ctx.kv.set(`${GRANT}${playSessionId}`, JSON.stringify({ ...g, ps: playSessionId } satisfies Grant), CONV_GRANT_TTL_S).catch(() => undefined);
  if (hint !== playSessionId) await ctx.kv.del(`${GRANT}${hint}`).catch(() => undefined);
}
export const dropConvGrant = (ctx: Ctx, hint: string) => bindConvGrant(ctx, hint, null);

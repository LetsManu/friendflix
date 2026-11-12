// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { timedClip } from './cliptime.js';
import type { Ctx } from './ctx.js';
import { within } from './convexempt.js';
import { listLive } from './live.js';
import type { EncoderSettings, HevcGate } from './media/types.js';
import { previews, serviceUser } from './previews.js';
import type { UserRow } from './types.js';

/**
 * The server's HEVC conversion (the media server encodes HEVC for remote viewers whose upload is short). The low-power Intel
 * encoder of a small server is easy to overload, so nothing is granted before a timed probe passed, at most HEVC_STREAMS run at
 * once (the server's own session list is the truth, plus a short grant window), and two failing devices pause it for hours.
 * State, probe records and Health carry only fixed codes and numbers: no URL, id, title or token.
 */
export type HevcState = 'off' | 'server_off' | 'no_hw' | 'unproven' | 'failed' | 'slow' | 'runtime_failed' | 'ready';
export interface HevcProbeRecord { ok: boolean; reason?: 'http' | 'not_hevc' | 'slow' | 'no_title'; speed?: number; fingerprint: string; at: number }

/** the probe must run at least this many times faster than real time */
export const HEVC_MIN_SPEED = 1.5;
/** below this speed at most ONE conversion runs at a time, whatever HEVC_STREAMS says (owner decision) */
export const HEVC_SAFE_SPEED = 3;
export const HEVC_PROBE_TTL_S = 48 * 3600;
export const HEVC_FAIL_WINDOW_MS = 3_600_000;
export const HEVC_FAIL_COOLDOWN_MS = 6 * 3_600_000;
export const HEVC_GRANT_TTL_S = 30;
export const HEVC_SESSIONS_TIMEOUT_MS = 800;
export const HEVC_ATTEMPT_GAP_S = 1800;
export const HW_TYPES: ReadonlySet<string> = new Set(['qsv', 'vaapi', 'nvenc', 'amf', 'videotoolbox', 'rkmpp']);

const PROBE_KEY = 'hevcenc:probe';
const ATTEMPT_KEY = 'hevcenc:attempt';
const FAIL_KEY = 'hevcenc:failures';
const LOCK_KEY = 'hevcenc:gate';
const RUN_KEY = 'hevcenc:running';
const RUN_TTL_S = 600;
const GRANT = 'hevcgrant:';
const PROBE_SEGMENTS = 4;
const SEGMENT_SECONDS = 3;

/** The settings the probe result depends on: a change of any of them makes an old result unproven. */
export const fingerprint = (e: EncoderSettings): string => [e.hwAccel, e.hevcEncode ? 1 : 0, e.hwEncode ? 1 : 0, e.lowPowerHevc ? 1 : 0].join('|');

/** Pure: the state from what is known. Anything unknown is never `ready`. */
export function hevcStateOf(o: { streams: number; kind: string; settings: EncoderSettings | null; probe: HevcProbeRecord | null; failures: Array<{ at: number; device: string }>; now: number }): HevcState {
  const { settings: e, probe } = o;
  if (o.streams <= 0 || o.kind !== 'jellyfin') return 'off';
  if (!e) return 'unproven';
  if (!e.hevcEncode) return 'server_off';
  if (!e.hwEncode || !HW_TYPES.has(e.hwAccel)) return 'no_hw';
  if (!probe || probe.fingerprint !== fingerprint(e) || probe.reason === 'no_title') return 'unproven';
  if (!probe.ok) return probe.reason === 'slow' ? 'slow' : 'failed';
  if (probe.speed === undefined || probe.speed < HEVC_MIN_SPEED) return 'slow';
  // two devices failed within the window: paused from the later failure on
  const sorted = [...o.failures].sort((a, b) => a.at - b.at);
  let trip = 0;
  sorted.forEach((f, j) => { if (sorted.slice(0, j).some((p) => p.device !== f.device && f.at - p.at <= HEVC_FAIL_WINDOW_MS)) trip = f.at; });
  if (trip && o.now - trip < HEVC_FAIL_COOLDOWN_MS) return 'runtime_failed';
  return 'ready';
}

const parse = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const readProbe = async (ctx: Ctx): Promise<HevcProbeRecord | null> => parse<HevcProbeRecord | null>(await ctx.kv.get(PROBE_KEY).catch(() => null), null);
const readFailures = async (ctx: Ctx): Promise<Array<{ at: number; device: string }>> => {
  const l = parse<unknown>(await ctx.kv.get(FAIL_KEY).catch(() => null), []);
  return Array.isArray(l) ? l.filter((f): f is { at: number; device: string } => typeof f?.at === 'number' && typeof f?.device === 'string') : [];
};

/** The media server's encoder settings, bounded by `ms` (null: no such read, it failed or it was late). Shared with convbench.ts. */
export const readSettings = async (ctx: Ctx, ms = 3000): Promise<EncoderSettings | null> => {
  const read = ctx.jf.admin.encoderSettings?.bind(ctx.jf.admin);
  return read ? ((await within(read, ms)) ?? null) : null;
};

export interface HevcStatus { state: HevcState; speed?: number; at?: string }

/** The state with the probe's speed and time, from settings that are already read (Health) or read now. */
export async function hevcStatus(ctx: Ctx, known?: EncoderSettings | null, settingsMs?: number): Promise<HevcStatus> {
  const streams = ctx.cfg.HEVC_STREAMS;
  if (streams <= 0 || ctx.jf.kind !== 'jellyfin') return { state: 'off' };
  const settings = known === undefined ? await readSettings(ctx, settingsMs) : known;
  const [probe, failures] = await Promise.all([readProbe(ctx), readFailures(ctx)]);
  const state = hevcStateOf({ streams, kind: ctx.jf.kind, settings, probe, failures, now: Date.now() });
  const shown = probe && settings && probe.fingerprint === fingerprint(settings) && probe.reason !== 'no_title';
  return { state, ...(shown && probe.speed !== undefined ? { speed: probe.speed } : {}), ...(shown ? { at: new Date(probe.at).toISOString() } : {}) };
}

/** A probe is worth running: HEVC conversion is on, the server's settings are readable and allow HEVC with hardware (else it would measure nothing). */
export async function hevcProbeWanted(ctx: Ctx, only?: HevcState): Promise<boolean> {
  if (ctx.cfg.HEVC_STREAMS <= 0 || ctx.jf.kind !== 'jellyfin') return false;
  const settings = await readSettings(ctx);
  if (!settings) return false;
  const st = (await hevcStatus(ctx, settings)).state;
  return only ? st === only : st !== 'off' && st !== 'server_off' && st !== 'no_hw';
}

const REFUSAL: Record<Exclude<HevcState, 'ready'>, Extract<HevcGate, { ok: false }>['why']> = {
  off: 'h264_off', server_off: 'h264_off', no_hw: 'h264_off', unproven: 'h264_unproven', failed: 'h264_unhealthy', slow: 'h264_unhealthy', runtime_failed: 'h264_unhealthy',
};

/** How many conversions may run at once: HEVC_STREAMS, but one while the probe measured less than 3x real time. */
export const effectiveLimit = (streams: number, speed: number | undefined): number => (speed !== undefined && speed < HEVC_SAFE_SPEED ? Math.min(streams, 1) : streams);

interface Grant { device?: string; ps?: string }

/**
 * May one more HEVC conversion start? Count = the server's non-direct HEVC sessions (minus this device's own, which this request
 * replaces) + grants of the last 30 s whose session the server does not list yet. A grant is written on success; the route binds it
 * to the real play session once Jellyfin has made it (bindHevcGrant). Unreadable or slow session list: no (h264_busy).
 */
export async function hevcGate(ctx: Ctx, o: { userId: string; deviceId?: string; playSessionIdHint?: string }): Promise<HevcGate> {
  const st = await hevcStatus(ctx, undefined, HEVC_SESSIONS_TIMEOUT_MS); // a slow settings read means unproven, never a slow start
  if (st.state !== 'ready') return { ok: false, why: REFUSAL[st.state] };
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  if (!list) return { ok: false, why: 'h264_busy' };
  // one asker at a time: two simultaneous asks must not both see a free slot (one retry for a friend starting at the same moment)
  const token = randomUUID();
  let locked = await ctx.kv.setnx(LOCK_KEY, token, 3).catch(() => false);
  if (!locked) {
    await new Promise((r) => setTimeout(r, 150));
    locked = await ctx.kv.setnx(LOCK_KEY, token, 3).catch(() => false);
  }
  if (!locked) return { ok: false, why: 'h264_busy' };
  try {
    const sessions = await within(list, HEVC_SESSIONS_TIMEOUT_MS);
    if (!sessions) return { ok: false, why: 'h264_busy' };
    const live = await listLive(ctx).catch(() => []);
    const mine = new Set<string>();
    if (o.deviceId) for (const l of live) if (l.userId === o.userId && l.deviceId === o.deviceId) mine.add(l.playSessionId);
    const bySession = new Map(sessions.flatMap((s) => (s.playSessionId ? [[s.playSessionId, s] as const] : [])));
    // conversions, one entry per play session: the server's non-direct HEVC sessions, portal streams planned as HEVC (a profile's
    // devices share one server session, so the server list alone can undercount), and grants not yet visible on the server
    const seen = new Set<string>();
    sessions.forEach((s, i) => { if (s.videoCodec === 'hevc' && s.videoDirect === false) seen.add(s.playSessionId ?? `anon:${i}`); });
    for (const l of live) {
      if (seen.has(l.playSessionId)) continue;
      const rec = parse<{ video?: unknown } | null>(await ctx.kv.get(`pbinfo:${l.userId}:${l.playSessionId}`).catch(() => null), null);
      if (rec?.video === 'hevc') seen.add(l.playSessionId);
    }
    for (const k of await ctx.kv.keys(GRANT).catch(() => [] as string[])) {
      const g = parse<Grant>(await ctx.kv.get(k).catch(() => null), {});
      if (!g || (g.device && o.deviceId && g.device === o.deviceId)) continue; // this device's earlier grant is replaced by this one
      if (g.ps && bySession.get(g.ps)?.videoCodec) continue; // the server reports it now: counted (or not) by its own entry
      seen.add(g.ps ?? `grant:${k}`);
    }
    for (const ps of mine) seen.delete(ps); // the requester's own stream is replaced by the new one
    if (seen.size >= effectiveLimit(ctx.cfg.HEVC_STREAMS, st.speed)) return { ok: false, why: 'h264_busy' };
    await ctx.kv.set(`${GRANT}${o.playSessionIdHint ?? randomUUID()}`, JSON.stringify({ ...(o.deviceId ? { device: o.deviceId } : {}) } satisfies Grant), HEVC_GRANT_TTL_S);
    return { ok: true };
  } finally {
    await ctx.kv.delIfEquals(LOCK_KEY, token).catch(() => undefined);
  }
}

/** After PlaybackInfo: the grant written for `hint` now belongs to the real play session (or is dropped when no conversion happens). */
export async function bindHevcGrant(ctx: Ctx, hint: string, playSessionId: string | null): Promise<void> {
  const raw = await ctx.kv.get(`${GRANT}${hint}`).catch(() => null);
  if (raw === null) return;
  await ctx.kv.del(`${GRANT}${hint}`).catch(() => undefined);
  if (playSessionId) await ctx.kv.set(`${GRANT}${playSessionId}`, JSON.stringify({ ...parse<Grant>(raw, {}), ps: playSessionId }), HEVC_GRANT_TTL_S).catch(() => undefined);
}

/** A player had to leave a HEVC conversion (the route calls this when its pbinfo says the replaced stream was HEVC). */
export async function noteHevcFailure(ctx: Ctx, deviceId: string): Promise<void> {
  const now = Date.now();
  const keep = (await readFailures(ctx)).filter((f) => now - f.at < HEVC_FAIL_COOLDOWN_MS + HEVC_FAIL_WINDOW_MS);
  keep.push({ at: now, device: createHash('sha256').update(deviceId).digest('hex').slice(0, 16) }); // only equality matters; no raw id is kept
  await ctx.kv.set(FAIL_KEY, JSON.stringify(keep.slice(-20)), Math.ceil((HEVC_FAIL_COOLDOWN_MS + HEVC_FAIL_WINDOW_MS) / 1000)).catch(() => undefined);
}

/** Is a probe running (any trigger, any backend process)? */
export const hevcProbeRunning = async (ctx: Ctx): Promise<boolean> => (await ctx.kv.get(RUN_KEY).catch(() => null)) !== null;
/** Atomic claim of the one probe slot: a token the probe releases with (only its own claim is ever deleted). null: another probe holds it. */
export async function claimHevcProbe(ctx: Ctx): Promise<string | null> {
  const token = randomUUID();
  return (await ctx.kv.setnx(RUN_KEY, token, RUN_TTL_S).catch(() => false)) ? token : null;
}
/** Releases the claim taken with `token` (never another holder's). Never throws. */
export async function releaseHevcProbe(ctx: Ctx, token: string): Promise<void> {
  await ctx.kv.delIfEquals(RUN_KEY, token).catch(() => undefined);
}

/**
 * Timed probe on the first SDR 720-1080p library title: a HEVC fMP4 conversion at 1080p / 6 Mbit/s (3 s segments). Master, variant
 * and init (must hold an hvcC box), then segments 0-3 in order; speed = media seconds / wall time. The conversion is always
 * stopped. Previews are paused and idle first. One probe at a time (KV claim). The result is stored for 48 h; only code, speed,
 * settings fingerprint and time. null: another probe holds the slot.
 */
export async function probeHevcEncoder(ctx: Ctx, user: UserRow, deps: { now?: () => number; claimed?: string } = {}): Promise<HevcProbeRecord | null> {
  const now = deps.now ?? Date.now;
  const token = deps.claimed ?? (await claimHevcProbe(ctx));
  if (!token) return null;
  await ctx.kv.set(ATTEMPT_KEY, String(now()), HEVC_ATTEMPT_GAP_S).catch(() => undefined);
  const pv = previews(ctx);
  const wasPaused = pv.paused;
  pv.paused = true;
  try {
    const settings = await readSettings(ctx);
    const fp = settings ? fingerprint(settings) : '';
    const done = async (r: Omit<HevcProbeRecord, 'fingerprint' | 'at'>): Promise<HevcProbeRecord> => {
      const rec: HevcProbeRecord = { ...r, fingerprint: fp, at: now() };
      if (settings) await ctx.kv.set(PROBE_KEY, JSON.stringify(rec), HEVC_PROBE_TTL_S).catch(() => undefined);
      return rec;
    };
    try {
      await pv.whenIdle();
      if (await hevcBusy(ctx)) return null; // someone started watching while a preview clip finished: nothing is converted or stored
      const r = await timedClip(ctx, user, { videoCodec: 'hevc', segments: PROBE_SEGMENTS, segmentSeconds: SEGMENT_SECONDS, checkInit: (init) => init.includes('hvcC'), now });
      if (!r.ok) return await done({ ok: false, reason: r.reason });
      return await done(r.speed < HEVC_MIN_SPEED ? { ok: false, reason: 'slow', speed: r.speed } : { ok: true, speed: r.speed });
    } catch {
      return await done({ ok: false, reason: 'http' });
    }
  } finally {
    pv.paused = wasPaused;
    await releaseHevcProbe(ctx, token);
  }
}

/**
 * Why the media server may not be disturbed: `watching` = a live portal stream or any transcode on the media server (an app of its
 * own); `unknown` = its session list could not be read in time (the probe would measure nothing useful anyway). null = free.
 */
export async function hevcBusyReason(ctx: Ctx): Promise<'watching' | 'unknown' | null> {
  if ((await listLive(ctx).catch(() => [{}])).length > 0) return 'watching';
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  if (!list) return null;
  const sessions = await within(list, HEVC_SESSIONS_TIMEOUT_MS);
  if (!sessions) return 'unknown';
  return sessions.some((s) => s.playMethod === 'Transcode') ? 'watching' : null;
}
export const hevcBusy = async (ctx: Ctx): Promise<boolean> => (await hevcBusyReason(ctx)) !== null;

/**
 * 10-minute timer: probes only when the state is `unproven`, nobody watches, previews are idle, none is running and the last attempt
 * (any trigger) is 30 min old. Returns whether a probe ran.
 */
export async function hevcTick(ctx: Ctx): Promise<boolean> {
  if (ctx.cfg.HEVC_STREAMS <= 0 || ctx.jf.kind !== 'jellyfin') return false;
  if (await hevcProbeRunning(ctx) || await hevcBusy(ctx) || !previews(ctx).idle) return false;
  if (!(await hevcProbeWanted(ctx, 'unproven'))) return false;
  if (!(await ctx.kv.setnx(ATTEMPT_KEY, String(Date.now()), HEVC_ATTEMPT_GAP_S).catch(() => false))) return false;
  const user = await serviceUser(ctx);
  if (!user) return false;
  return (await probeHevcEncoder(ctx, user)) !== null;
}

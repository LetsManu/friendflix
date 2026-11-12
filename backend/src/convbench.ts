// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { timedClip } from './cliptime.js';
import { conversionLimit, countConversions, readBench, type BenchRecord, type ConvEntry, type ConvKind, type ConvPriority } from './convbudget.js';
import { CONV_EXEMPT_PREFIX, within } from './convexempt.js';
import type { Ctx } from './ctx.js';
import { recordError } from './errorlog.js';
import { HEVC_SESSIONS_TIMEOUT_MS, claimHevcProbe, fingerprint, hevcProbeRunning, readSettings, releaseHevcProbe } from './hevcenc.js';
import { listLive, type Live } from './live.js';
import type { ServerSession } from './media/types.js';
import { previews, serviceUser } from './previews.js';

/**
 * The conversion benchmark (spec §5.3, ruling 11): a timed Jellyfin H.264 clip at 1080p / 6 Mbit/s, seven 3-s segments (21 s of
 * media), speed = media seconds / wall seconds. It takes the HEVC probe's claim, so the two never overlap; it never runs while anything
 * converts or anyone watches, and it never stops a conversion but its own (cliptime.ts). Its clip is exempt from the budget. The record
 * (KV conv:bench, 30 days) holds only speed, hardware acceleration, the encoder settings fingerprint and time. Another media server
 * (Plex) is not measured: its budget stays at the default 2 or the admin's value.
 */
export const BENCH_TTL_S = 30 * 86_400;
export const BENCH_ATTEMPT_GAP_S = 1800;
/** how long the outcome of the last run stays on the card */
export const BENCH_LAST_TTL_S = 86_400;
const BENCH_KEY = 'conv:bench';
const ATTEMPT_KEY = 'conv:bench:attempt';
const LAST_KEY = 'conv:bench:last';
const BENCH_SEGMENTS = 7;
const BENCH_SEGMENT_SECONDS = 3;

export type BenchTrigger = 'admin' | 'auto' | 'enable';
export type BenchBusy = 'watching' | 'unknown';
export type BenchRefusal = 'busy' | 'running' | 'no_title' | 'failed' | 'no_user' | 'unsupported';
export type BenchResult = { ok: true; jellyfin: BenchRecord | null; livetv: BenchRecord | null } | { ok: false; why: BenchRefusal };
/** what the last run ended with (`running` is never stored: such a run did not start) */
export type BenchOutcome = 'ok' | 'failed' | 'no_title' | 'busy' | 'no_user' | 'unsupported';

export interface ConversionsView {
  limit: number;
  auto: number;
  custom: number | null;
  priority: ConvPriority;
  used: number;
  running: Array<{ kind: ConvKind; hevc: boolean; label: string | null; since: string | null; device: string | null }>;
  bench: {
    jellyfin: { speed: number; hwAccel: string; at: string } | null;
    livetv: { speed: number; encoder: string; at: string } | null;
    recommended: number | null;
    stale: boolean;
    noRealtime: boolean;
  };
  /**
   * running: a measurement (this benchmark or the HEVC probe) holds the claim; busy: why *Neu messen* would be refused now; last: how the
   * last run ended within 24 h (null: none), `{ outcome: 'unsupported', at: null }` on a media server that is not measured (a state).
   */
  measure: { running: boolean; busy: BenchBusy | null; last: { outcome: BenchOutcome; at: string | null } | null };
}

/** Only Jellyfin is measured (spec §5.3). */
const measurable = (ctx: Ctx) => ctx.jf.kind === 'jellyfin';

/**
 * Converting sessions FriendFlix marked as its own housekeeping (preview clip, HEVC probe, this benchmark): they are not someone
 * watching. An unreadable mark counts as not exempt.
 */
async function exemptOf(ctx: Ctx, sessions: ServerSession[] | null): Promise<Set<string>> {
  const ps = (sessions ?? []).flatMap((s) => (s.playMethod === 'Transcode' && s.playSessionId ? [s.playSessionId] : []));
  if (!ps.length) return new Set();
  const marks = await ctx.kv.mget(ps.map((p) => `${CONV_EXEMPT_PREFIX}${p}`)).catch(() => [] as Array<string | null>);
  return new Set(ps.filter((_, i) => marks[i] != null));
}

/**
 * Why the media server may not be measured now, from lists already read: the semantics of hevcBusyReason (a portal stream, or any
 * transcode on the media server; an unreadable list is `unknown`) without FriendFlix's own exempt sessions, plus any conversion the
 * budget counts (a grant whose session the server does not list yet, a download preparation).
 */
function busyOf(live: Live[] | null, sessions: ServerSession[] | null, exempt: Set<string>, running: ConvEntry[] | null): BenchBusy | null {
  if (live === null || live.length > 0) return 'watching'; // as hevcBusyReason: an unreadable live list is not idle
  if (sessions === null) return 'unknown';
  if (sessions.some((s) => s.playMethod === 'Transcode' && !(s.playSessionId && exempt.has(s.playSessionId)))) return 'watching';
  if (running === null) return 'unknown';
  return running.length ? 'watching' : null;
}

/** The media server's sessions within 800 ms; [] for a server without a session list, null when unreadable or late. */
const readSessions = (ctx: Ctx): Promise<ServerSession[] | null> => {
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  return list ? within(list, HEVC_SESSIONS_TIMEOUT_MS).then((s) => s ?? null) : Promise.resolve([]);
};

async function benchBusy(ctx: Ctx): Promise<BenchBusy | null> {
  const [live, sessions, running] = await Promise.all([listLive(ctx).catch(() => null), readSessions(ctx), countConversions(ctx)]);
  return busyOf(live, sessions, await exemptOf(ctx, sessions), running);
}

const noteLast = (ctx: Ctx, outcome: BenchOutcome, at: number) =>
  ctx.kv.set(LAST_KEY, JSON.stringify({ outcome, at }), BENCH_LAST_TTL_S).catch(() => undefined);

/**
 * Measures the media server once and stores the result. `unsupported`: not Jellyfin; `running`: the HEVC probe or another benchmark
 * holds the claim; `busy`: someone watches or something converts (checked after previews are paused and idle); `no_user`: no admin
 * account to convert as; `no_title`: no SDR 720-1080p title to convert; `failed`: the clip did not convert or the record could not be
 * written (also noted as job error `conv-bench`, whatever the trigger). Nothing is stored unless it measured; every outcome but
 * `running` is kept for 24 h for the card (measure.last). `claimed`: a claim the caller took (startBenchmark), released here.
 * Unreadable encoder settings store the speed with an empty fingerprint (stale once they read again). Every trigger runs the same way.
 */
export async function runBenchmark(ctx: Ctx, _trigger: BenchTrigger, deps: { now?: () => number; claimed?: string } = {}): Promise<BenchResult> {
  const now = deps.now ?? Date.now;
  if (!measurable(ctx)) {
    if (deps.claimed) await releaseHevcProbe(ctx, deps.claimed);
    await noteLast(ctx, 'unsupported', now());
    return { ok: false, why: 'unsupported' };
  }
  const token = deps.claimed ?? (await claimHevcProbe(ctx));
  if (!token) return { ok: false, why: 'running' };
  const pv = previews(ctx);
  const wasPaused = pv.paused;
  pv.paused = true;
  let out: BenchResult = { ok: false, why: 'failed' };
  try {
    await pv.whenIdle();
    if (await benchBusy(ctx)) return (out = { ok: false, why: 'busy' });
    const user = await serviceUser(ctx).catch(() => undefined);
    if (!user) return (out = { ok: false, why: 'no_user' });
    await ctx.kv.set(ATTEMPT_KEY, String(now()), BENCH_ATTEMPT_GAP_S).catch(() => undefined);
    const settings = await readSettings(ctx);
    const r = await timedClip(ctx, user, { videoCodec: 'h264', segments: BENCH_SEGMENTS, segmentSeconds: BENCH_SEGMENT_SECONDS, now });
    if (!r.ok) return (out = { ok: false, why: r.reason === 'no_title' ? 'no_title' : 'failed' });
    const rec: BenchRecord = { speed: r.speed, hwAccel: settings?.hwAccel ?? 'unknown', fingerprint: settings ? fingerprint(settings) : '', at: now() };
    const written = await ctx.kv.set(BENCH_KEY, JSON.stringify(rec), BENCH_TTL_S).then(() => true, () => false);
    if (!written) return out;
    const { livetv } = await readBench(ctx);
    return (out = { ok: true, jellyfin: rec, livetv });
  } catch {
    return (out = { ok: false, why: 'failed' });
  } finally {
    pv.paused = wasPaused;
    await releaseHevcProbe(ctx, token);
    await noteLast(ctx, out.ok ? 'ok' : out.why as BenchOutcome, now());
    if (!out.ok && out.why === 'failed') await recordError(ctx, { source: 'job', code: 'conv-bench' }).catch(() => undefined); // one fixed code, nothing else
  }
}

/**
 * The admin's *Neu messen* (and Live TV's enable flow): refuses at once what cannot run now (not Jellyfin, a measurement holds the
 * claim, someone watches, no admin account to convert as), else measures in the background (about half a minute) under the claim it
 * took here, so `measure.running` is true from the answer on. The outcome lands in `measure.last`.
 */
export async function startBenchmark(ctx: Ctx, trigger: BenchTrigger): Promise<{ ok: true } | { ok: false; why: 'running' | 'no_user' | 'unsupported' } | { ok: false; why: 'busy'; reason: BenchBusy }> {
  if (!measurable(ctx)) return { ok: false, why: 'unsupported' };
  const claimed = await claimHevcProbe(ctx);
  if (!claimed) return { ok: false, why: 'running' };
  const reason = await benchBusy(ctx).catch((): BenchBusy => 'unknown');
  const user = reason ? undefined : await serviceUser(ctx).catch(() => undefined);
  if (reason || !user) {
    await releaseHevcProbe(ctx, claimed);
    return reason ? { ok: false, why: 'busy', reason } : { ok: false, why: 'no_user' };
  }
  void runBenchmark(ctx, trigger, { claimed }).catch(() => undefined);
  return { ok: true };
}

/**
 * 10-minute timer (next to hevcTick), Jellyfin only: measures when nothing (current) is measured — no record, or a stale one after the
 * encoder settings changed — while nobody watches, previews are idle, no probe runs, an admin account exists (else it skips quietly,
 * without using up an attempt) and the last attempt is 30 min old. Returns whether it attempted a measurement (also one that failed).
 */
export async function convBenchTick(ctx: Ctx): Promise<boolean> {
  if (!measurable(ctx)) return false;
  if (await hevcProbeRunning(ctx) || !previews(ctx).idle) return false;
  const b = await readBench(ctx);
  if (b.jellyfin && !b.stale) return false;
  if (await benchBusy(ctx)) return false;
  if (!(await serviceUser(ctx).catch(() => undefined))) return false;
  if (!(await ctx.kv.setnx(ATTEMPT_KEY, String(Date.now()), BENCH_ATTEMPT_GAP_S).catch(() => false))) return false;
  const r = await runBenchmark(ctx, 'auto');
  return r.ok || (r.why !== 'busy' && r.why !== 'running' && r.why !== 'no_user');
}

const readLast = async (ctx: Ctx): Promise<{ outcome: BenchOutcome; at: string } | null> => {
  try {
    const v = JSON.parse((await ctx.kv.get(LAST_KEY)) ?? 'null') as { outcome?: unknown; at?: unknown } | null;
    const ok: readonly unknown[] = ['ok', 'failed', 'no_title', 'busy', 'no_user', 'unsupported'];
    return v && ok.includes(v.outcome) && typeof v.at === 'number' ? { outcome: v.outcome as BenchOutcome, at: new Date(v.at).toISOString() } : null;
  } catch {
    return null;
  }
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Admin -> Betrieb -> Wiedergabe-Check, card *Umwandlungen*: the limit in force and where it comes from, what converts now (kind,
 * title, device), the measurements with the recommendation, and whether *Neu messen* can run and how it last ended. The session list
 * is read twice in parallel (inside countConversions, and here for device names and the busy check), each read bounded by 800 ms; an
 * unreadable session list shows nothing running and `busy: 'unknown'`.
 */
export async function conversionsView(ctx: Ctx): Promise<ConversionsView> {
  const [lim, b, running, sessions, live, measuring, last] = await Promise.all([
    conversionLimit(ctx),
    readBench(ctx),
    countConversions(ctx),
    readSessions(ctx),
    listLive(ctx).catch(() => null),
    hevcProbeRunning(ctx),
    readLast(ctx),
  ]);
  const entries = running ?? [];
  const exempt = await exemptOf(ctx, sessions);

  // the FriendFlix device label (its own name, else the browser label) where the stream is FriendFlix's, else the server's device name
  const labels = new Map<string, string>();
  const known = entries.filter((e) => e.device && e.userId);
  if (known.length) {
    const r = await ctx.db.query<{ user_id: string; device_id: string; label: string | null }>(
      'select user_id, device_id, coalesce(name, label) as label from devices where (user_id, device_id) in (select * from unnest($1::uuid[], $2::text[]))',
      [known.map((e) => e.userId), known.map((e) => e.device)],
    ).catch(() => ({ rows: [] as Array<{ user_id: string; device_id: string; label: string | null }> }));
    for (const x of r.rows) if (x.label) labels.set(`${x.user_id}|${x.device_id}`, x.label);
  }
  const serverName = new Map((sessions ?? []).flatMap((s) => (s.playSessionId && s.deviceName ? [[s.playSessionId, s.deviceName] as const] : [])));

  const speeds = [b.jellyfin?.speed, b.livetv?.speed].filter((v): v is number => typeof v === 'number');
  return {
    limit: lim.limit, auto: lim.auto, custom: lim.custom, priority: lim.priority,
    used: entries.length,
    running: entries.map((e) => ({
      kind: e.kind, hevc: e.hevc === true, label: e.label, since: iso(e.since),
      device: (e.device && e.userId ? labels.get(`${e.userId}|${e.device}`) : undefined) ?? serverName.get(e.key) ?? null,
    })),
    bench: {
      jellyfin: b.jellyfin ? { speed: b.jellyfin.speed, hwAccel: b.jellyfin.hwAccel, at: new Date(b.jellyfin.at).toISOString() } : null,
      livetv: b.livetv ? { speed: b.livetv.speed, encoder: b.livetv.hwAccel, at: new Date(b.livetv.at).toISOString() } : null,
      recommended: lim.recommended,
      stale: b.stale,
      noRealtime: speeds.length > 0 && Math.min(...speeds) < 1,
    },
    measure: { running: measuring, busy: busyOf(live, sessions, exempt, running), last: measurable(ctx) ? last : { outcome: 'unsupported', at: null } },
  };
}

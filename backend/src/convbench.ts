// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { timedClip } from './cliptime.js';
import { conversionLimit, countConversions, readBench, type BenchRecord, type ConvEntry, type ConvKind, type ConvPriority } from './convbudget.js';
import { within } from './convexempt.js';
import type { Ctx } from './ctx.js';
import { recordError } from './errorlog.js';
import { HEVC_SESSIONS_TIMEOUT_MS, claimHevcProbe, fingerprint, hevcBusyReason, hevcProbeRunning, releaseHevcProbe } from './hevcenc.js';
import { listLive, type Live } from './live.js';
import type { EncoderSettings, ServerSession } from './media/types.js';
import { previews, serviceUser } from './previews.js';

/**
 * The conversion benchmark (spec §5.3, ruling 11): a timed media server H.264 clip at 1080p / 6 Mbit/s, seven 3-s segments (21 s of
 * media), speed = media seconds / wall seconds. It takes the HEVC probe's claim, so the two never overlap; it never runs while anything
 * converts or anyone watches, and it never stops a conversion but its own (cliptime.ts). Its clip is exempt from the budget. The record
 * (KV conv:bench, 30 days) holds only speed, hardware acceleration, the encoder settings fingerprint and time.
 */
export const BENCH_TTL_S = 30 * 86_400;
export const BENCH_ATTEMPT_GAP_S = 1800;
const BENCH_KEY = 'conv:bench';
const ATTEMPT_KEY = 'conv:bench:attempt';
const BENCH_SEGMENTS = 7;
const BENCH_SEGMENT_SECONDS = 3;
const SETTINGS_TIMEOUT_MS = 3000;

export type BenchTrigger = 'admin' | 'auto' | 'enable';
export type BenchBusy = 'watching' | 'unknown';
export type BenchResult = { ok: true; jellyfin: BenchRecord | null; livetv: BenchRecord | null } | { ok: false; why: 'busy' | 'running' | 'no_title' | 'failed' };

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
  measure: { running: boolean; busy: BenchBusy | null };
}

/**
 * Why the media server may not be measured now: anyone watches or anything converts (hevcBusyReason), or the budget counts a
 * conversion (a grant whose session the server does not list yet, a download preparation); `unknown` when either list is unreadable.
 */
async function benchBusy(ctx: Ctx): Promise<BenchBusy | null> {
  const reason = await hevcBusyReason(ctx);
  if (reason) return reason;
  const running = await countConversions(ctx);
  if (!running) return 'unknown';
  return running.length ? 'watching' : null;
}

/** The same answer from lists already read (the admin view reads each list once). */
function busyOf(live: Live[] | null, sessions: ServerSession[] | null, running: ConvEntry[] | null): BenchBusy | null {
  if (live === null || live.length > 0) return 'watching'; // as hevcBusyReason: an unreadable live list is not idle
  if (sessions === null) return 'unknown';
  if (sessions.some((s) => s.playMethod === 'Transcode')) return 'watching';
  if (running === null) return 'unknown';
  return running.length ? 'watching' : null;
}

const readSettings = async (ctx: Ctx): Promise<EncoderSettings | null> => {
  const read = ctx.jf.admin.encoderSettings?.bind(ctx.jf.admin);
  return read ? ((await within(read, SETTINGS_TIMEOUT_MS)) ?? null) : null;
};

/**
 * Measures the media server once and stores the result. `running`: the HEVC probe or another benchmark holds the claim; `busy`: someone
 * watches or something converts (checked after previews are paused and idle); `no_title`: no SDR 720-1080p title to convert; `failed`:
 * the clip did not convert or the record could not be written. Nothing is stored unless it measured. `claimed`: a claim the caller took
 * (startBenchmark), released here. An automatic run that failed is noted as job error `conv-bench`. Unreadable encoder settings store the speed with an empty fingerprint (stale once they read again).
 */
export async function runBenchmark(ctx: Ctx, trigger: BenchTrigger, deps: { now?: () => number; claimed?: string } = {}): Promise<BenchResult> {
  const now = deps.now ?? Date.now;
  const token = deps.claimed ?? (await claimHevcProbe(ctx));
  if (!token) return { ok: false, why: 'running' };
  const pv = previews(ctx);
  const wasPaused = pv.paused;
  pv.paused = true;
  let out: BenchResult = { ok: false, why: 'failed' };
  try {
    await pv.whenIdle();
    if (await benchBusy(ctx)) return (out = { ok: false, why: 'busy' });
    await ctx.kv.set(ATTEMPT_KEY, String(now()), BENCH_ATTEMPT_GAP_S).catch(() => undefined);
    const user = await serviceUser(ctx).catch(() => undefined);
    if (!user) return out;
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
    // an automatic run that failed would go unseen otherwise (the admin sees their own on the card): one fixed code, nothing else
    if (trigger === 'auto' && !out.ok && out.why === 'failed') await recordError(ctx, { source: 'job', code: 'conv-bench' }).catch(() => undefined);
  }
}

/**
 * The admin's *Neu messen* (and Live TV's enable flow): takes the claim and checks the server is idle now, then measures in the
 * background (it takes about half a minute). Refusals come back at once; the claim makes `measure.running` true until it is done.
 */
export async function startBenchmark(ctx: Ctx, trigger: BenchTrigger): Promise<{ ok: true } | { ok: false; why: 'running' } | { ok: false; why: 'busy'; reason: BenchBusy }> {
  const claimed = await claimHevcProbe(ctx);
  if (!claimed) return { ok: false, why: 'running' };
  const reason = await benchBusy(ctx).catch((): BenchBusy => 'unknown');
  if (reason) {
    await releaseHevcProbe(ctx, claimed);
    return { ok: false, why: 'busy', reason };
  }
  void runBenchmark(ctx, trigger, { claimed }).catch(() => undefined);
  return { ok: true };
}

/**
 * 10-minute timer (next to hevcTick): measures when nothing (current) is measured — no record, or a stale one after the encoder settings
 * changed — while nobody watches, previews are idle, no probe runs and the last attempt is 30 min old. Returns whether it measured.
 */
export async function convBenchTick(ctx: Ctx): Promise<boolean> {
  if (await hevcProbeRunning(ctx) || !previews(ctx).idle) return false;
  const b = await readBench(ctx);
  if (b.jellyfin && !b.stale) return false;
  if (await benchBusy(ctx)) return false;
  if (!(await ctx.kv.setnx(ATTEMPT_KEY, String(Date.now()), BENCH_ATTEMPT_GAP_S).catch(() => false))) return false;
  const r = await runBenchmark(ctx, 'auto');
  return r.ok || (r.why !== 'busy' && r.why !== 'running');
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Admin -> Betrieb -> Wiedergabe-Check, card *Umwandlungen*: the limit in force and where it comes from, what converts now (kind,
 * title, device), the measurements with the recommendation, and whether *Neu messen* can run. Each list is read once, every media
 * server read bounded; an unreadable session list shows nothing running and `busy: 'unknown'`.
 */
export async function conversionsView(ctx: Ctx): Promise<ConversionsView> {
  const list = ctx.jf.admin.transcodeSessions?.bind(ctx.jf.admin);
  const [lim, b, running, sessions, live, measuring] = await Promise.all([
    conversionLimit(ctx),
    readBench(ctx),
    countConversions(ctx),
    list ? within(list, HEVC_SESSIONS_TIMEOUT_MS).then((s) => s ?? null) : Promise.resolve([] as ServerSession[]),
    listLive(ctx).catch(() => null),
    hevcProbeRunning(ctx),
  ]);
  const entries = running ?? [];

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
    measure: { running: measuring, busy: busyOf(live, sessions, running) },
  };
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { claimBenchAttempt, startBenchmark } from '../convbench.js';
import { readBench } from '../convbudget.js';
import type { Ctx } from '../ctx.js';
import { livetvCall, livetvHealth } from './client.js';
import type { Encoder, LivetvSystem } from './wire.js';

/**
 * Is the optional livetv container there (spec §4.1)? `GET /healthz` unsigned; installed = reachable and `api === 1` (a livetv
 * with another API number is reachable but not usable by this backend). The last answer is kept per process: `livetvInstalled` is
 * the sync read for `featureFlags` and the summary, `detectLivetv` refreshes it (one check at a time), `livetvDetectTick` runs it
 * every minute.
 */
export interface LivetvState { reachable: boolean; installed: boolean; version: string | null; bootId: string | null; checkedAt: number }

interface Slot { state: LivetvState | null; flight: Promise<LivetvState> | null }
const slots = new WeakMap<object, Slot>();
const slotOf = (ctx: Ctx): Slot => { let s = slots.get(ctx); if (!s) slots.set(ctx, s = { state: null, flight: null }); return s; };

/** last known, no request */
export function livetvInstalled(ctx: Ctx): boolean {
  return slots.get(ctx)?.state?.installed === true;
}

async function check(ctx: Ctx, slot: Slot): Promise<LivetvState> {
  const h = await livetvHealth(ctx);
  const next: LivetvState = { reachable: h !== null, installed: h !== null && h.api === 1, version: h?.version ?? null, bootId: h?.bootId ?? null, checkedAt: Date.now() };
  const was = slot.state?.installed; // undefined until the first look: a backend that starts next to a running livetv is not "just enabled"
  slot.state = next;
  // the first look after enabling (spec §5.3): measure the encoder livetv would use; one attempt per appearance
  if (was === false && next.installed && ctx.cfg.LIVETV_WANTED === 'true') void startBenchmark(ctx, 'enable').catch(() => undefined); // a refusal ({ ok: false }) is retried by the tick
  return next;
}

/** the state, from the last check when it is younger than `maxAgeMs`; checks run one at a time (callers share the running one) */
export async function detectLivetv(ctx: Ctx, maxAgeMs = 10_000): Promise<LivetvState> {
  const slot = slotOf(ctx);
  if (slot.state && Date.now() - slot.state.checkedAt < maxAgeMs) return slot.state;
  slot.flight ??= check(ctx, slot).finally(() => { slot.flight = null; });
  return slot.flight;
}

/**
 * every 60 s (server.ts): a fresh check, which also notices the first appearance after enabling. While livetv is installed and its
 * benchmark record is missing (enabled by hand, someone was watching at the first look, a refusal) the measurement is retried, at most
 * once per 30 min (the benchmark's attempt key); a restart alone is not an enable, but a missing record gets measured eventually.
 */
export async function livetvDetectTick(ctx: Ctx): Promise<void> {
  const st = await detectLivetv(ctx, 0);
  if (!st.installed) return;
  if ((await readBench(ctx, 1).catch(() => null))?.livetv) return;
  if (!(await claimBenchAttempt(ctx))) return;
  await startBenchmark(ctx, 'enable').catch(() => undefined); // { ok: false } (busy, running, ...) is simply tried again later
}

const SYSTEM_MEMO_MS = 10_000;
const ENCODERS: readonly string[] = ['h264_qsv', 'h264_vaapi', 'h264_nvenc', 'libx264'] satisfies Encoder[];
const memo = new WeakMap<object, { at: number; sys: LivetvSystem | null }>();
const strings = (v: unknown, max: number): string[] | null => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 120) ? (v as string[]) : null);

/** `GET /v1/system` as far as the admin page needs it (cached 10 s; null = not installed, not answering or an unexpected shape) */
export async function livetvSystem(ctx: Ctx): Promise<LivetvSystem | null> {
  if (!livetvInstalled(ctx)) return null;
  const hit = memo.get(ctx);
  if (hit && Date.now() - hit.at < SYSTEM_MEMO_MS) return hit.sys;
  const raw = await livetvCall<Partial<LivetvSystem> | null>(ctx, 'GET', '/v1/system', undefined, { timeoutMs: 3_000 }).catch(() => null);
  const devices = strings(raw?.gpu?.devices, 32), encoders = strings(raw?.encoders, 8);
  const sys: LivetvSystem | null = raw && raw.gpu && devices && encoders && encoders.every((e) => ENCODERS.includes(e)) ? {
    cpu: { model: String(raw.cpu?.model ?? '').slice(0, 120), cores: Number(raw.cpu?.cores) || 0, loadPct: Number(raw.cpu?.loadPct) || 0 },
    gpu: { devices, driver: typeof raw.gpu.driver === 'string' ? raw.gpu.driver.slice(0, 60) : null, readable: raw.gpu.readable === true, busyPct: typeof raw.gpu.busyPct === 'number' ? raw.gpu.busyPct : null },
    encoders: encoders as Encoder[],
    cache: { usedBytes: Number(raw.cache?.usedBytes) || 0, maxBytes: Number(raw.cache?.maxBytes) || 0 },
    recordings: raw.recordings ? { usedBytes: Number(raw.recordings.usedBytes) || 0, freeBytes: Number(raw.recordings.freeBytes) || 0 } : null,
    srt: { ports: Array.isArray(raw.srt?.ports) ? raw.srt.ports.filter((p): p is number => Number.isInteger(p)).slice(0, 100) : [] },
  } : null;
  memo.set(ctx, { at: Date.now(), sys });
  return sys;
}

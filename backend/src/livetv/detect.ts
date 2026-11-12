// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { startBenchmark } from '../convbench.js';
import type { Ctx } from '../ctx.js';
import { livetvCall, livetvHealth } from './client.js';
import type { Encoder, LivetvSystem } from './wire.js';

/**
 * Is the optional livetv container there (spec §4.1)? `GET /healthz?n=<nonce>` unsigned; installed = reachable, `api === 1` (a
 * livetv with another API number is reachable but not usable by this backend) and a valid proof of key for this check's nonce
 * (client.ts; 1b review I2: a LAN host that answers to the name `livetv` is reachable, never installed). The last answer is kept per process: `livetvInstalled` is
 * the sync read for `featureFlags` and the summary, `detectLivetv` refreshes it (one check at a time), `livetvDetectTick` runs it
 * every minute.
 */
export interface LivetvState { reachable: boolean; installed: boolean; version: string | null; bootId: string | null; checkedAt: number }

/**
 * how the benchmark after enabling went: `started` = launched (it runs in the background; its result appears on the conversions
 * card, not here), or why it was refused (busy, running, no_user, unsupported) or failed to launch
 */
export type EnableBenchmark = 'started' | 'busy' | 'running' | 'no_user' | 'unsupported' | 'error';
/** `appearance` counts the checks that found livetv absent: a benchmark answer belongs to the appearance it was launched in */
interface Slot { state: LivetvState | null; flight: Promise<LivetvState> | null; bench: EnableBenchmark | null; appearance: number }
const slots = new WeakMap<object, Slot>();
const slotOf = (ctx: Ctx): Slot => { let s = slots.get(ctx); if (!s) slots.set(ctx, s = { state: null, flight: null, bench: null, appearance: 0 }); return s; };

/** how the benchmark after the last enable went (null: none yet); shown in the admin state */
export const enableBenchmark = (ctx: Ctx): EnableBenchmark | null => slots.get(ctx)?.bench ?? null;

/** last known, no request */
export function livetvInstalled(ctx: Ctx): boolean {
  return slots.get(ctx)?.state?.installed === true;
}

async function check(ctx: Ctx, slot: Slot): Promise<LivetvState> {
  const h = await livetvHealth(ctx);
  // version and boot id only from an answer that proved the key: nothing an impostor says is kept
  const ok = h !== null && h.proof === 'ok';
  const next: LivetvState = { reachable: h !== null, installed: ok && h.api === 1, version: ok ? h.version : null, bootId: ok ? h.bootId : null, checkedAt: Date.now() };
  const was = slot.state?.installed; // undefined until the first look: a backend that starts next to a running livetv is not "just enabled"
  slot.state = next;
  if (!next.installed) { slot.bench = null; slot.appearance++; } // the outcome belongs to this appearance
  // the first look after enabling (spec §5.3): measure the encoder livetv would use; one attempt per appearance
  if (was === false && next.installed && ctx.cfg.LIVETV_WANTED === 'true') {
    slot.bench = null;
    // one attempt per appearance; a refusal ({ ok: false }) is kept for the admin state, not retried here. A late answer (livetv
    // vanished meanwhile, maybe came back) is dropped: it would describe an appearance that is gone (1b review M2)
    const mine = slot.appearance;
    const keep = (b: EnableBenchmark) => { if (slot.appearance === mine && slot.state?.installed) slot.bench = b; };
    void startBenchmark(ctx, 'enable').then((r) => keep(r.ok ? 'started' : r.why), () => keep('error'));
  }
  return next;
}

/** the state, from the last check when it is younger than `maxAgeMs`; checks run one at a time (callers share the running one) */
export async function detectLivetv(ctx: Ctx, maxAgeMs = 10_000): Promise<LivetvState> {
  const slot = slotOf(ctx);
  if (slot.state && Date.now() - slot.state.checkedAt < maxAgeMs) return slot.state;
  slot.flight ??= check(ctx, slot).finally(() => { slot.flight = null; });
  return slot.flight;
}

/** every 60 s (server.ts): a fresh check, which also notices the first appearance after enabling */
export async function livetvDetectTick(ctx: Ctx): Promise<void> {
  await detectLivetv(ctx, 0);
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
    gpu: { devices, driver: typeof raw.gpu.driver === 'string' ? raw.gpu.driver.slice(0, 60) : null, readable: raw.gpu.readable === true, busyPct: typeof raw.gpu.busyPct === 'number' ? raw.gpu.busyPct : null, nvidia: raw.gpu.nvidia === true },
    encoders: encoders as Encoder[],
    cache: { usedBytes: Number(raw.cache?.usedBytes) || 0, maxBytes: Number(raw.cache?.maxBytes) || 0 },
    recordings: raw.recordings ? { usedBytes: Number(raw.recordings.usedBytes) || 0, freeBytes: Number(raw.recordings.freeBytes) || 0 } : null,
    srt: { ports: Array.isArray(raw.srt?.ports) ? raw.srt.ports.filter((p): p is number => Number.isInteger(p)).slice(0, 100) : [] },
  } : null;
  memo.set(ctx, { at: Date.now(), sys });
  return sys;
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { Ctx } from './ctx.js';

/**
 * What became of "Update now" after it was handed to Portainer (updates.ts redeployViaPortainer). Portainer gives no progress of
 * its own and recreates this very backend halfway through, so the redeploy is recorded in the kv store (it outlives the backend
 * container) and its phase is worked out on every read of Admin -> Update from what can be seen afterwards:
 *
 *   pulling     Portainer has the redeploy and pulls the images (nothing recreated yet)
 *   recreating  some FriendFlix services already run another build or are not running (n of total on the new build)
 *   health      every service runs the new build, not all of them healthy yet
 *   done        a new build runs (or, of the same build, a change was seen) and every service is up and healthy
 *   unchanged   Portainer finished, but nothing was recreated (the tag had nothing newer, or the stack does not use FF_TAG)
 *   failed      Portainer refused the redeploy, also when its answer came only after the page was told "started"
 *   timeout     no end within 15 minutes (`at`: the phase it hung in)
 *
 * Judging the services needs the updater's listing. Without an updater (UPDATER_URL unset, or none answered when the redeploy
 * began) this backend's own build decides alone; with one that does not answer right now (Portainer recreates it too) the phase
 * waits instead of ending. One redeploy at a time (claimRedeploy). Only fixed codes, HTTP statuses and tags are stored: never a
 * URL, a key or Portainer's message text.
 */
export type RedeployPhase = 'pulling' | 'recreating' | 'health' | 'done' | 'unchanged' | 'failed' | 'timeout';
const PHASES: readonly RedeployPhase[] = ['pulling', 'recreating', 'health', 'done', 'unchanged', 'failed', 'timeout'];
const FINAL: readonly RedeployPhase[] = ['done', 'unchanged', 'failed', 'timeout'];
export const REDEPLOY_KEY = 'update:portainer:redeploy';
/** held from the start until the redeploy ended (or its timeout passed): a second start is refused as busy */
export const REDEPLOY_LOCK = 'update:portainer:redeploy:lock';
/** a short mutex around every read-modify-write of the record (a late answer vs. a read storing the end) */
const MUTEX = 'update:portainer:redeploy:mutex';
const TTL = 2 * 86_400;
export const REDEPLOY_TIMEOUT_MS = 15 * 60_000;
/** the services Portainer recreates that a redeploy is judged by (bootstrap only runs once per `up`) */
const SERVICES = ['backend', 'gateway', 'web'] as const;
/** when this backend process started: a process younger than the redeploy is a container Portainer recreated */
export const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);

interface Rec {
  v: 1;
  id: string; mode: 'webhook' | 'api'; startedAt: number; from: string; tag: string;
  /** an updater listed the services when the redeploy began (else this backend's build decides alone) */
  updater: boolean;
  /** Portainer's answer to the final call: none yet, 2xx (`answeredAt`), or a refusal */
  answer: 'pending' | 'ok' | 'failed'; answeredAt: number | null;
  /** the 2xx came once Portainer was done (its API before 2.36 redeploys, then answers; not "deploying" in the answer) */
  sync: boolean;
  /** a service was seen recreated (on another build, or not running) since the start */
  changed: boolean;
  error: string | null; step: string | null; status: number | null; code: string | null;
  final: RedeployPhase | null; finishedAt: number | null;
  /** timeout: the phase it hung in */
  at: RedeployPhase | null;
}

export interface RedeployView {
  id: string; mode: 'webhook' | 'api'; tag: string; phase: RedeployPhase; running: boolean;
  startedAt: string; finishedAt: string | null;
  /** FriendFlix services on the new build, of how many (null: the updater cannot list them) */
  services: { updated: number; total: number } | null;
  /** failed: the fixed code (portainer, portainer_unreachable, no_target), Portainer's HTTP status, the step, the errno code */
  error: string | null; status: number | null; step: string | null; code: string | null;
  /** timeout: the phase it hung in (pulling / recreating / health) */
  at: RedeployPhase | null;
}

export interface ServiceSeen { service: string; state: string; health: string; sha: string | null }

const str = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const phaseOrNull = (v: unknown): v is RedeployPhase | null => v === null || PHASES.includes(v as RedeployPhase);

/** the stored record, only in exactly this shape (an older or tampered value is ignored, never trusted) */
function parse(raw: string | null): Rec | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  const ok = str(o.id, /^[0-9a-f]{16}$/) && (o.mode === 'webhook' || o.mode === 'api') && typeof o.startedAt === 'number' && Number.isFinite(o.startedAt)
    && str(o.from, /^[A-Za-z0-9._-]{1,64}$/) && str(o.tag, /^[A-Za-z0-9._-]{1,64}$/) && typeof o.updater === 'boolean'
    && (o.answer === 'pending' || o.answer === 'ok' || o.answer === 'failed') && numOrNull(o.answeredAt) && typeof o.sync === 'boolean' && typeof o.changed === 'boolean'
    && (o.error === null || str(o.error, /^[a-z_]{1,40}$/)) && (o.step === null || str(o.step, /^[a-z_]{1,20}$/)) && numOrNull(o.status)
    && (o.code === null || str(o.code, /^[A-Z_]{2,40}$/)) && phaseOrNull(o.final) && numOrNull(o.finishedAt) && phaseOrNull(o.at);
  return ok ? (o as unknown as Rec) : null;
}
const read = async (ctx: Ctx): Promise<Rec | null> => parse(await ctx.kv.get(REDEPLOY_KEY).catch(() => null));
const write = (ctx: Ctx, r: Rec): Promise<boolean> => ctx.kv.set(REDEPLOY_KEY, JSON.stringify(r), TTL).then(() => true, () => false);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Runs `fn` while holding the short mutex (the kv store has no compare-and-set): a late answer from Portainer and a read that
 * stores the end cannot overwrite each other. undefined when the mutex could not be had within `waitMs`.
 */
async function locked<T>(ctx: Ctx, fn: () => Promise<T>, waitMs = 1_000): Promise<T | undefined> {
  const token = randomBytes(8).toString('hex');
  for (let waited = 0; ; waited += 25) {
    if (await ctx.kv.setnx(MUTEX, token, 5).catch(() => false)) break;
    if (waited >= waitMs) return undefined;
    await sleep(25);
  }
  try { return await fn(); } finally { await ctx.kv.delIfEquals(MUTEX, token).catch(() => undefined); }
}

const running = (r: Rec | null, now: number) => Boolean(r && !r.final && now - r.startedAt <= REDEPLOY_TIMEOUT_MS);
/** the slot while it is only claimed (a crash before the record is written frees it soon); held this long once recorded */
const CLAIM_S = 120;
const HOLD_S = REDEPLOY_TIMEOUT_MS / 1000 + 60;

/**
 * Takes the single redeploy slot: null (busy) while another redeploy runs or holds the slot. A claimed slot expires after two
 * minutes unless beginRedeploy recorded the redeploy (then it is held until the end, at most a minute past the timeout). A slot
 * left behind by a redeploy that already ended or ran out of time (its end not stored yet, or the release lost) is taken over.
 */
export async function claimRedeploy(ctx: Ctx, now = Date.now()): Promise<string | null> {
  const r = await read(ctx);
  if (running(r, now)) return null;
  const id = randomBytes(8).toString('hex');
  const take = () => ctx.kv.setnx(REDEPLOY_LOCK, id, CLAIM_S).catch(() => false);
  if (await take()) return id;
  const holder = await ctx.kv.get(REDEPLOY_LOCK).catch(() => null);
  // stale: held by the stored redeploy, which is not running any more (checked above)
  if (!r || !holder || holder !== r.id || !(await ctx.kv.delIfEquals(REDEPLOY_LOCK, holder).catch(() => false))) return null;
  return (await take()) ? id : null;
}
const release = (ctx: Ctx, id: string) => ctx.kv.delIfEquals(REDEPLOY_LOCK, id).catch(() => undefined);

/**
 * Records the redeploy that is about to be handed to Portainer (`id` from claimRedeploy) and holds the slot for it. false when
 * it could not be recorded (the store or its mutex not available): the caller gives the slot back and sends nothing.
 */
export async function beginRedeploy(ctx: Ctx, id: string, mode: 'webhook' | 'api', tag: string, updater: boolean, now = Date.now(), waitMs = 3_000): Promise<boolean> {
  // the slot first: a record must never stay "pending" for a redeploy that was not sent (a phantom "pulling", busy for 15 min)
  if (!(await ctx.kv.refreshIfEquals(REDEPLOY_LOCK, id, HOLD_S).catch(() => false))) return false;
  const ok = await locked(ctx, () => write(ctx, {
    v: 1, id, mode, startedAt: now, from: ctx.cfg.GIT_SHA, tag, updater, answer: 'pending', answeredAt: null, sync: false, changed: false,
    error: null, step: null, status: null, code: null, final: null, finishedAt: null, at: null,
  }), waitMs);
  return ok === true;
}

/** gives the slot back when nothing was recorded or started (Portainer refused at once is settled instead) */
export const abandonRedeploy = release;

export type Answer = { ok: true; sync: boolean } | { ok: false; error: string; step: string; status: number | null; code?: string };
/**
 * Portainer's answer (also a late one, after "started" went out): a refusal ends the redeploy as failed and frees the slot.
 * Under the mutex, a few tries; then written without it: a lost refusal is worse than a rare overwrite of a stored end.
 */
export async function settleRedeploy(ctx: Ctx, id: string, a: Answer, now = Date.now(), waitMs = 1_000, tries = 3): Promise<void> {
  const apply = async () => {
    const r = await read(ctx);
    if (!r || r.id !== id || r.answer !== 'pending' || (r.final && !(r.final === 'timeout' && !a.ok))) return true;
    if (a.ok) Object.assign(r, { answer: 'ok', answeredAt: now, sync: a.sync });
    else Object.assign(r, { answer: 'failed', answeredAt: now, error: a.error, step: a.step, status: a.status, code: a.code ?? null, final: 'failed', finishedAt: now, at: null });
    await write(ctx, r);
    if (r.final) await release(ctx, id);
    return true;
  };
  for (let i = 0; i < tries; i++) if (await locked(ctx, apply, waitMs)) return;
  await apply();
}

const healthy = (s: ServiceSeen) => s.state === 'running' && (s.health === '' || s.health === 'healthy');

/**
 * The last redeploy and its phase now. `services`: what the updater lists; undefined = there is no updater to ask (UPDATER_URL
 * unset), null = an updater is set up but gave no listing now. A phase that ended is stored (and the slot freed), so a later read
 * (another update by hand, a restart) does not change it.
 */
export async function redeployView(ctx: Ctx, services: readonly ServiceSeen[] | null | undefined, now = Date.now(), bootedAt = BOOTED_AT): Promise<RedeployView | null> {
  const r = await read(ctx);
  if (!r) return null;
  const fromTag = /^[0-9a-f]{7,40}$/.test(r.from) ? `sha-${r.from.slice(0, 7)}` : null;
  const seen = services?.filter((s) => (SERVICES as readonly string[]).includes(s.service)) ?? [];
  const onNew = (s: ServiceSeen) => s.state === 'running' && s.sha !== null && fromTag !== null && s.sha !== fromTag;
  const counts = seen.length ? { updated: seen.filter(onNew).length, total: seen.length } : null;
  let phase: RedeployPhase = r.final ?? 'pulling';
  if (!r.final) {
    // none: judge by this backend alone; down: an updater that listed the services at the start does not answer now
    const listing = services === undefined || !r.updater ? 'none' : seen.length ? 'list' : 'down';
    const changedNow = listing === 'list' && seen.some((s) => s.state !== 'running' || onNew(s));
    const changed = r.changed || changedNow;
    const newBuild = ctx.cfg.GIT_SHA !== r.from;
    const restarted = bootedAt > r.startedAt;
    const finished = r.answer === 'ok' && r.sync;
    // a restart of the same build alone proves nothing (a crash, a reboot): only with a change seen, or Portainer saying done
    if (newBuild || (changed && (restarted || finished))) {
      if (listing === 'list') {
        const pending = seen.filter((s) => !healthy(s) || (newBuild && fromTag !== null && s.sha === fromTag));
        phase = !pending.length ? 'done' : pending.some((s) => s.state !== 'running' || (newBuild && s.sha === fromTag)) ? 'recreating' : 'health';
      } else {
        phase = listing === 'none' ? 'done' : 'health';
      }
    } else if (changed) {
      phase = 'recreating';
    } else if (finished && listing !== 'down') {
      // Portainer redeployed and answered, this backend is the same container of the same build and nothing else changed
      phase = 'unchanged';
    }
    let at: RedeployPhase | null = null;
    if (!FINAL.includes(phase) && now - r.startedAt > REDEPLOY_TIMEOUT_MS) {
      // "nothing newer" only when it never got past pulling; stuck later is a timeout naming where
      if (r.answer === 'ok' && phase === 'pulling') phase = 'unchanged';
      else { at = phase; phase = 'timeout'; }
    }
    if (FINAL.includes(phase) || (changedNow && !r.changed)) {
      const stored = await locked(ctx, async () => {
        const cur = await read(ctx);
        // a late answer got in between (failed): that one stands
        if (!cur || cur.id !== r.id || cur.final || cur.answer !== r.answer) return cur;
        cur.changed = changed;
        if (FINAL.includes(phase)) Object.assign(cur, { final: phase, finishedAt: now, at });
        await write(ctx, cur);
        if (cur.final) await release(ctx, cur.id);
        return cur;
      });
      if (stored && stored.id === r.id && stored.final) return view(stored, stored.final, counts);
      if (stored === undefined && FINAL.includes(phase)) return view({ ...r, finishedAt: now, at }, phase, counts);
    }
  }
  return view(r, phase, counts);
}

function view(r: Rec, phase: RedeployPhase, counts: RedeployView['services']): RedeployView {
  return {
    id: r.id, mode: r.mode, tag: r.tag, phase, running: !FINAL.includes(phase), startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null, services: counts,
    error: r.error, status: r.status, step: r.step, code: r.code, at: phase === 'timeout' ? r.at : null,
  };
}

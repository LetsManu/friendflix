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
 *   done        this backend is a new container (new build, or recreated) and every service is up and healthy
 *   unchanged   Portainer finished, but nothing was recreated (the tag had nothing newer, or the stack does not use FF_TAG)
 *   failed      Portainer refused the redeploy, also when its answer came only after the page was told "started"
 *   timeout     no change within 15 minutes and no answer from Portainer
 *
 * Only fixed codes, HTTP statuses and tags are stored: never a URL, a key or Portainer's message text.
 */
export type RedeployPhase = 'pulling' | 'recreating' | 'health' | 'done' | 'unchanged' | 'failed' | 'timeout';
const FINAL: readonly RedeployPhase[] = ['done', 'unchanged', 'failed', 'timeout'];
export const REDEPLOY_KEY = 'update:portainer:redeploy';
const TTL = 2 * 86_400;
export const REDEPLOY_TIMEOUT_MS = 15 * 60_000;
/** the services Portainer recreates that a redeploy is judged by (bootstrap only runs once per `up`) */
const SERVICES = ['backend', 'gateway', 'web'] as const;
/** when this backend process started: a process younger than the redeploy is a container Portainer recreated */
export const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);

interface Rec {
  id: string; mode: 'webhook' | 'api'; startedAt: number; from: string; tag: string;
  /** Portainer's answer to the final call: none yet, 2xx (`at` when it came), or a refusal */
  answer: 'pending' | 'ok' | 'failed'; answeredAt: number | null;
  error: string | null; step: string | null; status: number | null; code: string | null;
  final: RedeployPhase | null; finishedAt: number | null;
}

export interface RedeployView {
  id: string; mode: 'webhook' | 'api'; tag: string; phase: RedeployPhase; running: boolean;
  startedAt: string; finishedAt: string | null;
  /** FriendFlix services on the new build, of how many (null: the updater cannot list them) */
  services: { updated: number; total: number } | null;
  /** failed: the fixed code, Portainer's HTTP status and the step (webhook / stack / stack_file / redeploy), the errno code */
  error: string | null; status: number | null; step: string | null; code: string | null;
}

export interface ServiceSeen { service: string; state: string; health: string; sha: string | null }

async function read(ctx: Ctx): Promise<Rec | null> {
  const raw = await ctx.kv.get(REDEPLOY_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as Rec; } catch { return null; }
}
const write = (ctx: Ctx, r: Rec) => ctx.kv.set(REDEPLOY_KEY, JSON.stringify(r), TTL).catch(() => undefined);

/** records a redeploy that is about to be handed to Portainer; returns its id */
export async function beginRedeploy(ctx: Ctx, mode: 'webhook' | 'api', tag: string, now = Date.now()): Promise<string> {
  const id = randomBytes(8).toString('hex');
  await write(ctx, { id, mode, startedAt: now, from: ctx.cfg.GIT_SHA, tag, answer: 'pending', answeredAt: null, error: null, step: null, status: null, code: null, final: null, finishedAt: null });
  return id;
}

/** Portainer's answer (also a late one, after "started" went out): a refusal ends the redeploy as failed */
export async function settleRedeploy(ctx: Ctx, id: string, a: { ok: true } | { ok: false; error: string; step: string; status: number | null; code?: string }, now = Date.now()): Promise<void> {
  const r = await read(ctx);
  if (!r || r.id !== id || r.answer !== 'pending' || r.final) return;
  if (a.ok) Object.assign(r, { answer: 'ok', answeredAt: now });
  else Object.assign(r, { answer: 'failed', answeredAt: now, error: a.error, step: a.step, status: a.status, code: a.code ?? null, final: 'failed', finishedAt: now });
  await write(ctx, r);
}

const healthy = (s: ServiceSeen) => s.state === 'running' && (s.health === '' || s.health === 'healthy');

/**
 * The last redeploy and its phase now. `services`: what the updater sees running (null without an updater). A phase that ended
 * is stored, so a later read (another update by hand, a restart) does not change it.
 */
export async function redeployView(ctx: Ctx, services: readonly ServiceSeen[] | null, now = Date.now(), bootedAt = BOOTED_AT): Promise<RedeployView | null> {
  const r = await read(ctx);
  if (!r) return null;
  let phase: RedeployPhase = r.final ?? 'pulling';
  const fromTag = /^[0-9a-f]{7,40}$/.test(r.from) ? `sha-${r.from.slice(0, 7)}` : null;
  const seen = services?.filter((s) => (SERVICES as readonly string[]).includes(s.service)) ?? [];
  const onNew = (s: ServiceSeen) => s.state === 'running' && s.sha !== null && fromTag !== null && s.sha !== fromTag;
  const counts = seen.length ? { updated: seen.filter(onNew).length, total: seen.length } : null;
  if (!r.final) {
    const newBuild = ctx.cfg.GIT_SHA !== r.from;
    const recreated = newBuild || bootedAt > r.startedAt;
    if (recreated) {
      // this backend is Portainer's new container: done once every service runs (the new build, when it is one) and is healthy
      const pending = seen.filter((s) => !healthy(s) || (newBuild && fromTag !== null && s.sha === fromTag));
      phase = !pending.length ? 'done' : pending.some((s) => s.state !== 'running' || (newBuild && s.sha === fromTag)) ? 'recreating' : 'health';
    } else if (counts && (counts.updated > 0 || seen.some((s) => s.state !== 'running'))) {
      phase = 'recreating';
    } else if (r.answer === 'ok' && r.answeredAt !== null && r.answeredAt - r.startedAt >= 5_000) {
      // Portainer answered only after it was done (its API redeploys before it answers) and this backend is still the same
      // container of the same build: nothing was recreated
      phase = 'unchanged';
    }
    if (!FINAL.includes(phase) && now - r.startedAt > REDEPLOY_TIMEOUT_MS) phase = r.answer === 'ok' ? 'unchanged' : 'timeout';
    if (FINAL.includes(phase)) { r.final = phase; r.finishedAt = now; await write(ctx, r); }
  }
  return {
    id: r.id, mode: r.mode, tag: r.tag, phase, running: !FINAL.includes(phase), startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null, services: counts,
    error: r.error, status: r.status, step: r.step, code: r.code,
  };
}

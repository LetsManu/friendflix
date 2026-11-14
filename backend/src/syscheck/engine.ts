// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { checkLoginFlows, type LoginCheck } from '../flowCheck.js';
import { bounded, getSnapshot, type HealthSnapshot } from '../health.js';
import { cleanLine, line } from './line.js';
import { CHECK_IDS, CHECK_STATUSES, type CheckGroup, type CheckId, type CheckLine, type CheckStatus, type SystemcheckResult } from './types.js';

export { line, safeParams } from './line.js';
export { CHECK_TIMEOUT_MS, SIGNIN_TIMEOUT_MS } from './types.js';

/**
 * The Systemcheck engine (spec: docs/superpowers/specs/2026-11-14-systemcheck-design.md). Every group check runs in parallel under its own
 * time limit; a miss is `unknown`/`check_timeout` for its lines (the work underneath, e.g. checkLoginFlows, keeps running and fills its own
 * cache), a throw `unknown`/`check_failed` (logged as `{check, code}` only, never the message). The result is cached in kv like the health
 * snapshot: fresh for 60 s, served stale and rebuilt in the background up to 300 s, single flight per ctx; without kv it is built in-process.
 */
export interface CheckEnv {
  ctx: Ctx;
  /** the health snapshot, read once per run (memoised; `fresh` rebuilds it); a check that does not need it never waits for it */
  snapshot(): Promise<HealthSnapshot>;
  /** the sign-in check (checkLoginFlows), memoised per run */
  login(): Promise<LoginCheck>;
  /** Jetzt prüfen: inputs are read fresh, not from their caches */
  fresh: boolean;
  /** this check's time limit (a probe inside should finish well before it) */
  timeoutMs: number;
}

export interface GroupCheck {
  group: CheckGroup;
  /** the lines this check answers for (unknown when it misses its limit) */
  ids: readonly CheckId[];
  timeoutMs: number;
  run(env: CheckEnv): Promise<CheckLine[]>;
}

const RESULT_KEY = 'syscheck:result';
const RESULT_TTL_S = 300;
const FRESH_MS = 60_000;
/** a kv read never holds up the answer for longer (Redis down: built in-process) */
const KV_READ_MS = 1_000;
const ORDER = new Map<string, number>(CHECK_IDS.map((id, i) => [id, i]));

let registry: GroupCheck[] = [];

/** Adds group checks to the module registry (a check already registered is not added twice). */
export function registerChecks(list: GroupCheck[]): void {
  for (const c of list) if (!registry.includes(c)) registry.push(c);
}

/** Tests: an empty registry (then registerChecks with fakes). */
export function resetChecksForTests(): void {
  registry = [];
}

export const sortLines = (lines: CheckLine[]): CheckLine[] => [...lines].sort((a, b) => (ORDER.get(a.id) ?? 1e6) - (ORDER.get(b.id) ?? 1e6));

export function countLines(lines: CheckLine[]): Record<CheckStatus, number> {
  const counts = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const l of lines) counts[l.status]++;
  return counts;
}

/** A check's lines: only its own ids, each once and cleaned; an id it left out is unknown/check_failed. */
function own(ctx: Ctx, c: GroupCheck, lines: CheckLine[]): CheckLine[] {
  const byId = new Map<CheckId, CheckLine>();
  for (const l of Array.isArray(lines) ? lines : []) if (l && c.ids.includes(l.id) && !byId.has(l.id)) byId.set(l.id, cleanLine(ctx, l));
  return c.ids.map((id) => byId.get(id) ?? line(id, 'unknown', { cause: 'check_failed' }));
}

async function runCheck(ctx: Ctx, c: GroupCheck, env: Omit<CheckEnv, 'timeoutMs'>): Promise<CheckLine[]> {
  const o = await bounded(() => c.run({ ...env, timeoutMs: c.timeoutMs }), c.timeoutMs);
  if (o.ok) return own(ctx, c, o.v);
  const code = o.timeout ? 'check_timeout' : 'check_failed';
  console.warn('systemcheck: check did not finish', { check: c.group, code });
  return c.ids.map((id) => line(id, 'unknown', { cause: code }));
}

/** One run of every registered check, in parallel, each under its own limit. Never throws. */
export async function buildSystemcheck(ctx: Ctx, o: { fresh?: boolean } = {}): Promise<SystemcheckResult> {
  const fresh = o.fresh === true;
  let snap: Promise<HealthSnapshot> | undefined;
  let login: Promise<LoginCheck> | undefined;
  const env = {
    ctx, fresh,
    snapshot: () => (snap ??= getSnapshot(ctx, { refresh: fresh })),
    login: () => (login ??= checkLoginFlows(ctx, { fresh })),
  };
  const lines = sortLines((await Promise.all(registry.map((c) => runCheck(ctx, c, env)))).flat());
  return { at: new Date().toISOString(), lines, counts: countLines(lines) };
}

// single flight per process, keyed by ctx (tests run several apps in one process); `fresh` marks a Jetzt-prüfen build
const inflight = new WeakMap<object, { fresh: boolean; p: Promise<SystemcheckResult> }>();

function rebuild(ctx: Ctx, fresh: boolean): Promise<SystemcheckResult> {
  const cur = inflight.get(ctx);
  if (cur && (cur.fresh || !fresh)) return cur.p;
  const p: Promise<SystemcheckResult> = buildSystemcheck(ctx, { fresh })
    .then((r) => {
      void ctx.kv.set(RESULT_KEY, JSON.stringify(r), RESULT_TTL_S).catch(() => undefined);
      return r;
    })
    .finally(() => { if (inflight.get(ctx)?.p === p) inflight.delete(ctx); });
  inflight.set(ctx, { fresh, p });
  return p;
}

async function stored(ctx: Ctx): Promise<SystemcheckResult | null> {
  const o = await bounded(() => ctx.kv.get(RESULT_KEY), KV_READ_MS);
  if (!o.ok || !o.v) return null;
  try {
    const r = JSON.parse(o.v) as SystemcheckResult;
    return typeof r?.at === 'string' && Array.isArray(r.lines) ? r : null;
  } catch {
    return null;
  }
}

/** The cached result: fresh → as is; older → served at once and rebuilt in the background; missing or refresh → built and awaited. */
export async function getSystemcheck(ctx: Ctx, o: { refresh?: boolean } = {}): Promise<SystemcheckResult> {
  if (o.refresh) return rebuild(ctx, true);
  const s = await stored(ctx);
  if (!s) return rebuild(ctx, false);
  if (!(Date.now() - Date.parse(s.at) <= FRESH_MS)) void rebuild(ctx, false).catch(() => undefined);
  return s;
}

/** Tests: resolves once a background rebuild (if any) has finished. */
export async function systemcheckSettled(ctx: Ctx): Promise<void> {
  await inflight.get(ctx)?.p.catch(() => undefined);
}

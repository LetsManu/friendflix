// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { StepError } from '../docker.js';
import { EngineError, type Engine } from './engine.js';
import { assertHelper } from './guard.js';
import { hdrSpec, type CreateRequest } from './template.js';
import { MEDIA_ERRORS, type MediaError } from './types.js';

/**
 * Runs the short-lived helper containers (spec "Helper containers"): create, start, wait, read the log, remove. Every body passes
 * the guard before it leaves the process; helpers are always removed together with their anonymous volumes (never left behind).
 */

type Expect = Parameters<typeof assertHelper>[1];

/** an engine failure as a job error code: known codes pass through, a timeout is `helper_timeout`, anything else `helper_failed` */
function mapped(e: unknown): StepError {
  if (e instanceof StepError) return e;
  if (e instanceof EngineError) {
    if (e.code === 'timeout') return new StepError('helper_timeout');
    if ((MEDIA_ERRORS as readonly string[]).includes(e.code)) return new StepError(e.code as MediaError);
  }
  return new StepError('helper_failed');
}

/** create, start, wait and read stdout (tail `tail`, only when asked); the container is removed in every case */
async function run(engine: Engine, req: CreateRequest, expect: Expect, limitMs: number, tail: number): Promise<{ exit: number; lines: string[] }> {
  assertHelper(req.body, expect);
  let id: string;
  try { id = await engine.create(req); } catch (e) { throw mapped(e); }
  let timedOut = false;
  try {
    await engine.start(id);
    let exit: number;
    try {
      exit = await engine.wait(id, limitMs);
    } catch (e) {
      if (!(e instanceof EngineError) || e.code !== 'timeout') throw e;
      timedOut = true;
      await engine.stop(id, 1).catch(() => undefined);
      throw new StepError('helper_timeout');
    }
    const lines = tail > 0 ? await engine.logs(id, tail, 'stdout') : [];
    return { exit, lines };
  } catch (e) {
    throw mapped(e);
  } finally {
    await engine.remove(id, timedOut ? { force: true, volumes: true } : { volumes: true }).catch(() => undefined);
  }
}

/** the helper's one JSON line (the last non-empty stdout line); anything else is `helper_failed` */
export async function runHelper(engine: Engine, req: CreateRequest, expect: Expect, limitMs: number): Promise<Record<string, unknown>> {
  const { lines } = await run(engine, req, expect, limitMs, 50);
  const last = [...lines].reverse().find((l) => l.trim() !== '');
  let v: unknown;
  try { v = last === undefined ? undefined : JSON.parse(last); } catch { v = undefined; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new StepError('helper_failed');
  return v as Record<string, unknown>;
}

/** removes every helper of this project (leftovers of an interrupted run); returns how many were removed */
export async function cleanupHelpers(engine: Engine, project: string): Promise<number> {
  const found = await engine.listContainers({ 'friendflix.managed': 'helper', 'friendflix.project': project }, true);
  let n = 0;
  for (const c of found) {
    if (c.labels['friendflix.managed'] !== 'helper' || c.labels['friendflix.project'] !== project) continue;
    try { await engine.remove(c.id, { force: true, volumes: true }); n++; } catch { /* already gone or busy: the next run tries again */ }
  }
  return n;
}

/** probe.sh test 1 (pass = exit 0) or test 2 (pass = a stdout line `RESULT qsv PASS …`) */
export async function runHdr(engine: Engine, test: 1 | 2, o: Parameters<typeof hdrSpec>[1], limitMs: number): Promise<'pass' | 'fail'> {
  const { exit, lines } = await run(engine, hdrSpec(test, o), { project: o.project, uid: o.uid, gid: o.gid, image: o.image, verb: 'hdr', kind: o.kind }, limitMs, test === 2 ? 500 : 0);
  if (test === 1) return exit === 0 ? 'pass' : 'fail';
  return lines.some((l) => l.startsWith('RESULT qsv PASS')) ? 'pass' : 'fail';
}

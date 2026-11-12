// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import type { Ctx } from '../ctx.js';
import { invalidateLivetvRights } from './rights.js';

/**
 * One Live TV write (sources, own feeds): `fn` runs in one transaction, optionally under a transaction-scoped advisory lock taken
 * first (`lock`: a name, hashed by Postgres), and the cached channel sets are dropped afterwards (also after a rollback: harmless).
 * groups.ts keeps its own helper because it maps constraint violations differently.
 */
export async function livetvWrite<T>(ctx: Pick<Ctx, 'db'>, fn: (c: pg.PoolClient) => Promise<T>, o: { lock?: string } = {}): Promise<T> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    if (o.lock) await c.query('select pg_advisory_xact_lock(hashtext($1))', [o.lock]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    invalidateLivetvRights();
  }
}

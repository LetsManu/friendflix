// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';

export async function audit(ctx: Pick<Ctx, 'db'>, actor: string | null, action: string, target?: string, meta: Record<string, unknown> = {}) {
  await ctx.db.query('insert into audit_log(actor, action, target, meta) values ($1,$2,$3,$4)', [actor, action, target ?? null, JSON.stringify(meta)]).catch(() => undefined);
}

/**
 * audit() for a write inside a transaction (`ctx.db` = its client): an error is thrown instead of swallowed, so the transaction rolls
 * back and a stored change never lacks its entry (a swallowed error would leave the transaction aborted and its COMMIT a silent rollback).
 */
export async function auditInTx(ctx: Pick<Ctx, 'db'>, actor: string | null, action: string, target?: string, meta: Record<string, unknown> = {}) {
  await ctx.db.query('insert into audit_log(actor, action, target, meta) values ($1,$2,$3,$4)', [actor, action, target ?? null, JSON.stringify(meta)]);
}

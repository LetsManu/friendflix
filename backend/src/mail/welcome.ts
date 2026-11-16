// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { mailPerson } from './people.js';

/**
 * The welcome mail (docs/superpowers/plans/2026-11-16-mail-stage-b.md, Controller's call 4): once per account ever. The claim is
 * users.welcomed_at, set atomically by the first call (two sign-ins at once on two instances: one wins); the outbox key
 * `welcome:<userId>` alone would not do, since the outbox deletes its rows after 30 days. The claim is made even when no mail can go
 * out (no address, mail not set up, no PUBLIC_URL): an account is welcomed once, at its first sign-in, or never. Only a failed
 * queueing (a database error) gives the claim back. Migration 58 marks every account that existed at the deploy as welcomed.
 *
 * True when this call claimed it (whether or not a mail was queued).
 */
export async function welcomeOnce(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string): Promise<boolean> {
  // the claim as text: a JS Date would drop its microseconds, and the give-back below must match it exactly
  const r = await ctx.db.query<{ name: string; claimed: string }>(
    'update users set welcomed_at = now() where id = $1 and welcomed_at is null returning name, welcomed_at::text claimed', [userId]);
  const row = r.rows[0];
  if (!row) return false;
  try {
    await mailPerson(ctx, userId, 'welcome', { name: row.name }, `welcome:${userId}`);
  } catch (e) {
    // the queueing failed (a database error): the claim goes back, so the next sign-in tries again; should the row have landed
    // after all, its outbox key `welcome:<userId>` keeps that try from queueing a second mail
    await ctx.db.query('update users set welcomed_at = null where id = $1 and welcomed_at = $2::timestamptz', [userId, row.claimed]).catch(() => undefined);
    throw e;
  }
  return true;
}

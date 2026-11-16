// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import { mailPerson } from './people.js';

/**
 * The welcome mail (docs/superpowers/plans/2026-11-16-mail-stage-b.md, Controller's call 4): once per account ever. The claim is
 * users.welcomed_at, set atomically by the first call (two sign-ins at once on two instances: one wins); the outbox key
 * `welcome:<userId>` alone would not do, since the outbox deletes its rows after 30 days. The claim is made even when no mail can go
 * out (no address, mail not set up, no PUBLIC_URL): an account is welcomed once, at its first sign-in, or never. Migration 58 marks
 * every account that existed at the deploy as welcomed.
 *
 * True when this call claimed it (whether or not a mail was queued).
 */
export async function welcomeOnce(ctx: Pick<Ctx, 'db' | 'cfg' | 'encKey'>, userId: string): Promise<boolean> {
  const r = await ctx.db.query<{ name: string }>('update users set welcomed_at = now() where id = $1 and welcomed_at is null returning name', [userId]);
  const row = r.rows[0];
  if (!row) return false;
  await mailPerson(ctx, userId, 'welcome', { name: row.name }, `welcome:${userId}`);
  return true;
}

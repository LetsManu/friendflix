import { randomUUID } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { randomToken, sha256 } from './crypto.js';

export interface InviteRow {
  id: string;
  role: string;
  note: string | null;
  expires_at: Date;
  used_at: Date | null;
  authentik_invite: string | null;
}

export async function createInvite(ctx: Ctx, createdBy: string, opts: { role: string; ttlHours: number; note?: string }) {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + opts.ttlHours * 3600_000);
  let akId: string | null = null;
  let enrollUrl: string | undefined;
  const { AUTHENTIK_URL: url, AUTHENTIK_API_TOKEN: tok, AUTHENTIK_ENROLL_FLOW: flow } = ctx.cfg;
  if (url && tok && flow) {
    // Best effort: a single-use Authentik invitation drives account + MFA enrollment. API shape: Authentik >= 2023.x
    try {
      const r = await ctx.fetchImpl(new URL('/api/v3/stages/invitation/invitations/', url), {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `ff-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, single_use: true, expires: expiresAt.toISOString(), fixed_data: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        akId = ((await r.json()) as { pk: string }).pk;
        enrollUrl = `${url.replace(/\/$/, '')}/if/flow/${flow}/?itoken=${akId}`;
      }
    } catch {
      /* fall back to portal-only invite */
    }
  }
  const id = randomUUID();
  await ctx.db.query('insert into invites(id, token_hash, role, note, expires_at, created_by, authentik_invite) values ($1,$2,$3,$4,$5,$6,$7)', [
    id, sha256(token), opts.role, opts.note ?? null, expiresAt, createdBy, akId,
  ]);
  return { id, token, link: `${ctx.cfg.PUBLIC_URL.replace(/\/$/, '')}/invite/${token}`, enrollUrl, expiresAt };
}

/** Returns the invite if it exists, is unused and not expired. */
export async function lookupInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  if (!/^[\w-]{20,80}$/.test(token)) return null;
  const r = await ctx.db.query<InviteRow>('select id, role, note, expires_at, used_at, authentik_invite from invites where token_hash=$1 and used_at is null and expires_at > now()', [sha256(token)]);
  return r.rows[0] ?? null;
}

/** Atomically consumes an invite (single use even under concurrent logins). */
export async function claimInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  const r = await ctx.db.query<InviteRow>(
    'update invites set used_at = now() where token_hash=$1 and used_at is null and expires_at > now() returning id, role, note, expires_at, used_at, authentik_invite',
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}

export async function releaseInvite(ctx: Ctx, id: string) {
  await ctx.db.query('update invites set used_at = null, used_by = null where id=$1', [id]);
}

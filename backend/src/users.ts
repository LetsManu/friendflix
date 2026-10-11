import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { Ctx } from './ctx.js';
import { encrypt, randomPassword } from './crypto.js';
import { policyFromTemplate } from './jellyfin/client.js';
import { effectiveRole } from './roles.js';
import type { OidcClaims } from './oidc.js';
import type { UserRow } from './types.js';

export async function getUserById(ctx: Ctx, id: string): Promise<UserRow | null> {
  const r = await ctx.db.query<UserRow>('select * from users where id = $1', [id]);
  return r.rows[0] ?? null;
}

export async function getUserBySub(ctx: Ctx, sub: string): Promise<UserRow | null> {
  const r = await ctx.db.query<UserRow>('select * from users where authentik_sub = $1', [sub]);
  return r.rows[0] ?? null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'freund';

/** Resolves a role template's library names to Jellyfin media folder IDs and writes the Jellyfin policy. */
export async function applyRole(ctx: Ctx, jellyfinUserId: string, role: string, disabled = false) {
  const t = await effectiveRole(ctx, role);
  if (!t) throw new Error(`unknown role ${role}`);
  let ids: string[] | null = null;
  if (t.libraries !== 'all') {
    const folders = await ctx.jf.client.mediaFolders();
    const want = new Set(t.libraries.map((n) => n.toLowerCase()));
    ids = folders.filter((f) => want.has(f.Name.toLowerCase())).map((f) => f.Id);
  }
  await ctx.jf.client.setPolicy(jellyfinUserId, { ...policyFromTemplate(t, ids), IsDisabled: disabled });
}

/**
 * Creates the 1:1 mapping Authentik account = portal user = Jellyfin account:
 * a Jellyfin user with a random password (stored AES-GCM encrypted), role policy applied.
 */
export async function provisionUser(ctx: Ctx, claims: OidcClaims, role: string): Promise<UserRow> {
  const base = safeName(claims.name ?? claims.email?.split('@')[0] ?? 'freund');
  const password = randomPassword();
  let jf: { Id: string } | undefined;
  let jfName = base;
  for (let attempt = 0; attempt < 4 && !jf; attempt++) {
    jfName = attempt === 0 ? base : `${base}${Math.floor(100 + Math.random() * 900)}`;
    try {
      jf = await ctx.jf.client.createUser(jfName, password);
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  try {
    await applyRole(ctx, jf!.Id, role);
    const id = randomUUID();
    const r = await ctx.db.query<UserRow>(
      `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [id, claims.sub, claims.email ?? null, claims.name ?? jfName, role, jf!.Id, jfName, encrypt(ctx.encKey, password)],
    );
    await ctx.db.query('insert into profiles(id, user_id, name, is_owner) values ($1,$1,$2,true) on conflict do nothing', [id, r.rows[0]!.name.slice(0, 20) || 'Profil']);
    await audit(ctx, id, 'user.provisioned', id, { role, jellyfin: jfName });
    return r.rows[0]!;
  } catch (e) {
    await ctx.jf.client.deleteUser(jf!.Id).catch(() => undefined); // roll back the orphaned Jellyfin account
    throw e;
  }
}

/** Re-applies the effective role policy to all non-disabled users of a role. Returns the number of failures. */
export async function reapplyRole(ctx: Ctx, role: string): Promise<number> {
  const r = await ctx.db.query<{ jellyfin_user_id: string }>('select jellyfin_user_id from users where role=$1 and not disabled', [role]);
  let failed = 0;
  for (const u of r.rows) await applyRole(ctx, u.jellyfin_user_id, role, false).catch(() => { failed++; });
  return failed;
}

/** One-time startup job (flag in app_flags): old accounts still carry the pre-maxHeight policies (e.g. guests without transcoding). Call after migrate. */
export async function reapplyPoliciesOnce(ctx: Ctx, flag = 'reapply_roles_v1'): Promise<void> {
  const got = await ctx.db.query('insert into app_flags(key) values ($1) on conflict do nothing returning key', [flag]);
  if (!got.rowCount) return;
  let failed = 0;
  for (const role of Object.keys(ctx.roles)) failed += await reapplyRole(ctx, role);
  if (failed) await ctx.db.query('delete from app_flags where key=$1', [flag]); // retry on next start
}

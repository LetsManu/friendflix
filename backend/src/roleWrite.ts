// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { z } from 'zod';
import { auditInTx } from './audit.js';
import type { Ctx } from './ctx.js';
import { MATRIX_FIELDS, PERM_KEYS, permsPatch, readPerms, type MatrixField, type PermKey } from './perms.js';
import { featureFlags } from './features.js';
import { fetchLibraries, knownLibraries, missingLibraries, type Library } from './libraries.js';
import { defaultLimit } from './requestlimit.js';
import { diffRights, invalidateRights, roleRights, same, valueOf, type RightKey, type RightSource } from './rights.js';
import { invitableRoles, listRoles, roleLabelArgs, type RoleRow } from './rolecat.js';
import { wellFormed } from './wellFormed.js';
import { DEFAULT_ROLES, LEGACY_COLUMNS, TEMPLATE_KEYS, legacyColumns, invalidateRoles, own, readTemplate, type RoleTemplate } from './roles.js';
import { HttpError, accountSerial, reapplyRole } from './users.js';

/**
 * The role editor (spec §4.1): GET /api/admin/roles (the legacy fields plus the role matrix) and the partial role write behind
 * PUT /api/admin/roles/:role. A write merges into role_settings.template / perms (null = back to the inherited value, 'unlimited' = no
 * cap), dual-writes the old role_settings columns (one-release rollback), audits one role.update per stored change and re-applies the
 * media server policy only when the effective value of a field the server enforces changed.
 */

// ---- the partial role write ----

const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
/** a role label: 1-30 characters, well-formed Unicode (a lone surrogate would fail the audit insert) */
export const roleLabelInput = z.string().trim().min(1).max(30).refine(wellFormed);
const bitrate = z.number().int().min(300_000).max(200_000_000);
/** PUT /api/admin/roles/:role: every field optional, null = back to the inherited value; 'unlimited' lifts a cap (ruling 2) */
export const rolePatch = z.object({
  label: nullable(roleLabelInput),
  invitable: z.boolean().optional(),
  requestsPerMonth: nullable(z.union([z.number().int().min(0).max(100), z.literal('unlimited')])),
  maxStreams: nullable(z.number().int().min(1).max(50)),
  maxBitrate: nullable(bitrate),
  remoteMaxBitrate: nullable(bitrate),
  transcoding: nullable(z.boolean()),
  maxHeight: nullable(z.union([z.number().int().min(144).max(4320), z.literal('unlimited')])),
  maxParentalRating: nullable(z.union([z.number().int().min(0).max(21), z.literal('unlimited')])),
  libraries: nullable(z.union([z.literal('all'), z.array(z.string().trim().min(1).max(100).refine(wellFormed)).min(1).max(50)])),
  download: nullable(z.boolean()),
  maxDownloads: nullable(z.number().int().min(0).max(200)),
  downloadMaxHeight: nullable(z.number().int().min(0).max(2160)), // 0 = no downloads
  downloadDays: nullable(z.number().int().min(1).max(90)),
  perms: permsPatch.optional(),
}).strict();
export type RolePatch = z.infer<typeof rolePatch>;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The stored JSON with the known keys cleaned (a value of the wrong shape dropped) and keys of another version kept, so a write never
 * loses what a newer release stored.
 */
function cleaned(raw: unknown, known: readonly string[], clean: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(raw) ? { ...raw } : {};
  for (const k of known) {
    if (Object.hasOwn(clean, k)) out[k] = clean[k];
    else delete out[k];
  }
  return out;
}

/**
 * Writes a partial role change in one transaction (serialized per role, so two admins editing different fields of one role keep
 * each other's change): template / perms merged, requests_per_month (null → the code default of the base, 'unlimited' → SQL null),
 * the old columns dual-written from the merged template, label / invitable into the catalogue, and one role.update audit entry:
 * `{ from, to }` of the changed effective values, plus `layer` for a value that only moved between layers (pinned at the role or back
 * to inherited, `{ [key]: { from, to } }` sources). No change → no entry. Everything inside the transaction runs on its one connection
 * (no second pool client while the role lock is held). After commit the caches are dropped and the identities of the role get their
 * policy again when the effective value of a media-enforced field changed. `changed`: the audited keys.
 */
export async function writeRole(ctx: Ctx, actor: string | null, key: string, patch: RolePatch): Promise<{ changed: string[]; reapplied: { identities: number; failed: number } }> {
  const cat = (await listRoles(ctx)).find((r) => r.key === key);
  if (!cat) throw new HttpError(404, 'not_found');
  if (key === 'admin' && patch.perms !== undefined) throw new HttpError(400, 'admin_perms_locked');
  if (key === 'admin' && patch.invitable === true) throw new HttpError(400, 'admin_not_invitable');
  const libraries = Array.isArray(patch.libraries) ? await knownLibraries(ctx, patch.libraries) : patch.libraries;
  const touchesSettings = Object.keys(patch).some((k) => k !== 'label' && k !== 'invitable');
  const touchesCatalogue = patch.label !== undefined || patch.invitable !== undefined;

  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  const layer: Record<string, { from: string; to: string }> = {};
  let media = false;
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`role:${key}`]);
    // the resolver reads the catalogue through this connection: a fresh ctx object, so nothing cached from before the lock is used
    const tx = { db: c, roles: ctx.roles };
    const catRow = (await c.query<{ label: string | null; invitable: boolean; base: string }>('select label, invitable, base from roles where key=$1 for update', [key])).rows[0];
    if (!catRow && !Object.hasOwn(ctx.roles, key)) throw new HttpError(404, 'not_found'); // deleted while this write waited
    if (touchesCatalogue && !catRow) throw new HttpError(400, 'not_in_catalogue'); // a ROLE_TEMPLATES key the catalogue cannot hold
    const base = catRow?.base ?? cat.base;

    if (touchesCatalogue && catRow) {
      const label = patch.label === undefined ? catRow.label : patch.label;
      const invitable = patch.invitable ?? catRow.invitable;
      if (label !== catRow.label) { from.label = catRow.label; to.label = label; }
      if (invitable !== catRow.invitable) { from.invitable = catRow.invitable; to.invitable = invitable; }
      if (label !== catRow.label || invitable !== catRow.invitable) await c.query('update roles set label=$2, invitable=$3 where key=$1', [key, label, invitable]);
    }
    if (touchesSettings) {
      const cur = (await c.query<{ template: unknown; perms: unknown; requests_per_month: number | null }>(
        'select template, perms, requests_per_month from role_settings where role=$1', [key])).rows[0];
      const template = cleaned(cur?.template, TEMPLATE_KEYS, readTemplate(cur?.template));
      for (const k of TEMPLATE_KEYS) {
        const v = k === 'libraries' ? libraries : patch[k];
        if (v === undefined) continue;
        if (v === null) delete template[k];
        else template[k] = v === 'unlimited' ? null : v;
      }
      const perms = cleaned(cur?.perms, PERM_KEYS, readPerms(cur?.perms));
      for (const [k, v] of Object.entries(patch.perms ?? {}) as Array<[PermKey, boolean | null | undefined]>) {
        if (v === null) delete perms[k];
        else if (v !== undefined) perms[k] = v;
      }
      const rq = patch.requestsPerMonth;
      const requestsPerMonth = rq === undefined ? (cur ? cur.requests_per_month : defaultLimit(base)) : rq === null ? defaultLimit(base) : rq === 'unlimited' ? null : rq;
      const next = { template, perms, requestsPerMonth };
      const prev = cur ? { template: cur.template, perms: cur.perms, requestsPerMonth: cur.requests_per_month } : null;
      const before = (await roleRights(tx, key, prev))!;
      const after = (await roleRights(tx, key, next))!;
      const d = diffRights(before, after);
      Object.assign(from, d.from);
      Object.assign(to, d.to);
      Object.assign(layer, d.layer);
      media = d.media;
      if (!prev || !same(prev, next)) {
        const cols = Object.values(LEGACY_COLUMNS);
        await c.query(
          `insert into role_settings(role, requests_per_month, template, perms, ${cols.join(', ')}) values ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(', ')})
           on conflict (role) do update set requests_per_month = excluded.requests_per_month, template = excluded.template, perms = excluded.perms,
             ${cols.map((col) => `${col} = excluded.${col}`).join(', ')}, updated_at = now()`,
          [key, requestsPerMonth, JSON.stringify(template), JSON.stringify(perms), ...legacyColumns(readTemplate(template))]);
      }
    }
    // in the transaction: an entry for every stored change, in commit order (the role lock is still held)
    if (Object.keys(to).length) await auditInTx({ db: c }, actor, 'role.update', key, { from, to, ...(Object.keys(layer).length ? { layer } : {}) });
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  invalidateRoles(ctx);
  invalidateRights(); // accountsWithout answers follow the role's switches
  const reapplied = media
    ? await accountSerial(() => reapplyRole(ctx, key)) // after a role change of one of its accounts, never interleaved with it
    : { identities: 0, failed: 0 };
  return { changed: Object.keys(to), reapplied };
}

// ---- GET /api/admin/roles ----

type RoleSourceName = Exclude<RightSource, 'user' | 'kids'>;
export interface MatrixRole {
  key: string;
  /** the configured label (catalogue ← ROLE_TEMPLATES ← the base's built-in label); builtinLabel: it is the built-in German default */
  label: string | null; builtinLabel: boolean;
  /** the built-in role whose defaults apply below (a fallback label is the base's: the web translates the base) */
  base: string;
  origin: RoleRow['origin']; invitable: boolean; position: number;
  accounts: number; profiles: number; kidsProfiles: number;
  /** effective template + switches + requestsPerMonth, keyed by MatrixField.key */
  values: Record<string, unknown>;
  sources: Record<string, RoleSourceName>;
  /** library names of the role's template the media server no longer has (shown as "nicht mehr vorhanden") */
  missingLibraries: string[];
}
export interface RolesOverview {
  /** legacy (one release): effective template per role */
  roles: Record<string, RoleTemplate & { builtinLabel: boolean }>;
  invitable: string[];
  /** legacy (one release): the old roles page's rows */
  limits: Array<Record<string, unknown>>;
  matrix: { fields: MatrixField[]; features: ReturnType<typeof featureFlags>; roles: MatrixRole[]; libraries: Library[] };
}

/** the role editor's data: legacy `roles` / `invitable` / `limits` (unchanged fields) and the role matrix (spec §4.1, ruling 3) */
export async function rolesOverview(ctx: Ctx): Promise<RolesOverview> {
  const [catalogue, invitable, libs, counts] = await Promise.all([
    listRoles(ctx),
    invitableRoles(ctx),
    fetchLibraries(ctx),
    ctx.db.query<{ role: string; accounts: number; profiles: number; kids: number }>(
      `select u.role, count(distinct u.id)::int accounts, count(p.id)::int profiles, (count(p.id) filter (where p.kids))::int kids
         from users u left join profiles p on p.user_id = u.id group by u.role`),
  ]);
  const count = new Map(counts.rows.map((r) => [r.role, r]));
  const roles: RolesOverview['roles'] = {};
  const limits: RolesOverview['limits'] = [];
  const matrixRoles: MatrixRole[] = [];
  for (const row of catalogue) {
    const r = await roleRights(ctx, row.key);
    if (!r) continue;
    const { requestsPerMonth, ...template } = r.template;
    const builtin = own(DEFAULT_ROLES, row.key)?.label === template.label;
    Object.defineProperty(roles, row.key, { value: { ...template, builtinLabel: builtin }, enumerable: true, writable: true, configurable: true });
    // the remote cap without the role row: ROLE_TEMPLATES, else the code default of the base
    const remoteDefault = (own(ctx.roles, row.key) ?? own(DEFAULT_ROLES, row.base) ?? DEFAULT_ROLES.friend!).remoteMaxBitrate;
    limits.push({
      role: row.key, label: template.label, builtinLabel: builtin, requestsPerMonth, isDefault: r.sources.requestsPerMonth !== 'role',
      transcoding: template.transcoding, maxHeight: template.maxHeight, download: template.download, maxDownloads: template.maxDownloads,
      downloadMaxHeight: template.downloadMaxHeight, downloadDays: template.downloadDays, maxBitrate: template.maxBitrate,
      remoteMaxBitrate: template.remoteMaxBitrate, remoteDefault, remoteIsDefault: r.sources.remoteMaxBitrate !== 'role',
    });
    const [, configured, builtinGerman] = await roleLabelArgs(ctx, row.key);
    const n = count.get(row.key);
    matrixRoles.push({
      key: row.key, label: configured ?? null, builtinLabel: configured !== undefined && configured === builtinGerman, base: row.base,
      origin: row.origin, invitable: row.invitable && row.key !== 'admin', position: row.position,
      accounts: n?.accounts ?? 0, profiles: n?.profiles ?? 0, kidsProfiles: n?.kids ?? 0,
      values: Object.fromEntries(MATRIX_FIELDS.map((f) => [f.key, valueOf(r, f.key)])),
      sources: Object.fromEntries(MATRIX_FIELDS.map((f) => [f.key, r.sources[f.key as RightKey]])),
      missingLibraries: missingLibraries(template.libraries, libs),
    });
  }
  return {
    roles, invitable, limits,
    matrix: { fields: MATRIX_FIELDS.map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) })), features: featureFlags(ctx), roles: matrixRoles, libraries: libs ?? [] },
  };
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
// roles.ts and rolecat.ts import each other: neither may use the other's exports at module load, only inside functions
import type { Ctx } from './ctx.js';
import { invalidateCatalogue, listRoles } from './rolecat.js';

export const roleTemplateSchema = z.object({
  label: z.string(),
  /** 'all' or library (media folder) names */
  libraries: z.union([z.literal('all'), z.array(z.string())]),
  /** Jellyfin MaxParentalRating (e.g. 12). null = unrestricted */
  maxParentalRating: z.number().int().nullable(),
  /** bits per second */
  maxBitrate: z.number().int().positive(),
  /** bits per second when the viewer is NOT on a home network (HOME_NETWORKS); never above maxBitrate */
  remoteMaxBitrate: z.number().int().positive(),
  maxStreams: z.number().int().positive(),
  transcoding: z.boolean(),
  /** max video height in px (playback is capped/transcoded down to it). null = no cap */
  maxHeight: z.number().int().positive().nullable(),
  download: z.boolean(),
  /** max simultaneously active offline licenses per account */
  maxDownloads: z.number().int().min(0).max(200),
  /** max height of downloaded copies (0 = no downloads) */
  downloadMaxHeight: z.number().int().min(0).max(2160),
  /** validity of a license in days */
  downloadDays: z.number().int().min(1).max(90),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;

export const DEFAULT_ROLES: Record<string, RoleTemplate> = {
  friend: { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20_000_000, remoteMaxBitrate: 8_000_000, maxStreams: 2, transcoding: true, maxHeight: null, download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30 },
  family: { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40_000_000, remoteMaxBitrate: 8_000_000, maxStreams: 4, transcoding: true, maxHeight: null, download: true, maxDownloads: 25, downloadMaxHeight: 1080, downloadDays: 30 },
  guest: { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8_000_000, remoteMaxBitrate: 4_000_000, maxStreams: 1, transcoding: true, maxHeight: 1080, download: false, maxDownloads: 0, downloadMaxHeight: 0, downloadDays: 30 },
  admin: { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60_000_000, remoteMaxBitrate: 12_000_000, maxStreams: 6, transcoding: true, maxHeight: null, download: true, maxDownloads: 50, downloadMaxHeight: 1080, downloadDays: 30 },
};

export const INVITABLE_ROLES = ['friend', 'family', 'guest'] as const;

export function loadRoles(overrideJson?: string): Record<string, RoleTemplate> {
  if (!overrideJson) return DEFAULT_ROLES;
  const o = z.record(z.string(), roleTemplateSchema.partial()).parse(JSON.parse(overrideJson));
  const out: Record<string, RoleTemplate> = { ...DEFAULT_ROLES };
  for (const [k, v] of Object.entries(o)) out[k] = { ...(DEFAULT_ROLES[k] ?? DEFAULT_ROLES.friend!), ...v } as RoleTemplate;
  return out;
}

export const MAX_HEIGHTS = [720, 1080, 1440, 2160] as const;
const TTL_MS = 30_000;

/** the template fields a role row or an account override can set (the label lives in the role catalogue) */
export type TemplateKey = Exclude<keyof RoleTemplate, 'label'>;
export const TEMPLATE_KEYS: readonly TemplateKey[] = ['libraries', 'maxParentalRating', 'maxBitrate', 'remoteMaxBitrate', 'maxStreams', 'transcoding', 'maxHeight', 'download', 'maxDownloads', 'downloadMaxHeight', 'downloadDays'];
/** which layer decided a template field of a role: the code default, ROLE_TEMPLATES, or the role row (role_settings.template) */
export type RoleLayer = 'default' | 'env' | 'role';
type Stored = { template: Partial<Omit<RoleTemplate, 'label'>>; perms: unknown };
const cache = new WeakMap<object, { at: number; rows: Map<string, Stored> }>();
type RoleCtx = Pick<Ctx, 'db' | 'roles'>;

/**
 * A stored partial template (role_settings.template) → the known fields whose value fits the field; anything else is ignored, never an
 * error. An explicit null is "unlimited" for maxHeight and maxParentalRating (their schemas allow it), for no other field.
 */
export function readTemplate(raw: unknown): Partial<Omit<RoleTemplate, 'label'>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const k of TEMPLATE_KEYS) {
    if (!Object.hasOwn(raw, k)) continue;
    const v = roleTemplateSchema.shape[k].safeParse((raw as Record<string, unknown>)[k]);
    if (v.success) out[k] = v.data;
  }
  return out as Partial<Omit<RoleTemplate, 'label'>>;
}

/** the role_settings row of a role (template, perms), cached ~30 s per ctx with all rows */
export async function storedRole(ctx: Pick<Ctx, 'db'>, role: string): Promise<Stored | undefined> {
  let c = cache.get(ctx);
  if (!c || Date.now() - c.at > TTL_MS) {
    const r = await ctx.db.query<{ role: string; template: unknown; perms: unknown }>('select role, template, perms from role_settings');
    c = { at: Date.now(), rows: new Map(r.rows.map((x) => [x.role, { template: readTemplate(x.template), perms: x.perms }])) };
    cache.set(ctx, c);
  }
  return c.rows.get(role);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A role's template with the layer that decided each field: code default ← ROLE_TEMPLATES (ctx.roles) ← role row
 * (role_settings.template). A role without a ROLE_TEMPLATES key (admin-created, or an env role that left ROLE_TEMPLATES) starts from
 * the code default of its catalogue base. `base` picks the default permissions; `perms` is the stored perms JSON (rights.ts reads it).
 * An env field equal to the code default counts as `default`. undefined for a role that is neither in ctx.roles nor in the catalogue.
 */
export async function resolveRole(ctx: RoleCtx, role: string): Promise<{ template: RoleTemplate; sources: Record<TemplateKey, RoleLayer>; base: string; perms: unknown } | undefined> {
  const env = ctx.roles[role];
  const row = (await listRoles(ctx)).find((r) => r.key === role);
  if (!env && !row) return undefined;
  const base = row?.base ?? (Object.hasOwn(DEFAULT_ROLES, role) ? role : 'friend');
  const code = (env ? DEFAULT_ROLES[role] : DEFAULT_ROLES[base]) ?? DEFAULT_ROLES.friend!;
  const from = env ?? code;
  const template: RoleTemplate = { ...from, label: row?.label ?? from.label };
  const sources = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, env && !same(env[k], code[k]) ? 'env' : 'default'])) as Record<TemplateKey, RoleLayer>;
  const stored = await storedRole(ctx, role);
  for (const [k, v] of Object.entries(stored?.template ?? {}) as Array<[TemplateKey, never]>) {
    template[k] = v;
    sources[k] = 'role';
  }
  return { template, sources, base, perms: stored?.perms };
}

/** Code default <- ROLE_TEMPLATES env (ctx.roles) <- role_settings.template (admin UI); also catalogue-only roles. Cached ~30 s per ctx. */
export async function effectiveRole(ctx: RoleCtx, role: string): Promise<RoleTemplate | undefined> {
  return (await resolveRole(ctx, role))?.template;
}

/** the old role_settings columns (dual-written for one release) and the template field each one holds */
export const LEGACY_COLUMNS = {
  transcoding: 'transcoding', maxHeight: 'max_height', download: 'download', maxDownloads: 'max_downloads',
  downloadMaxHeight: 'download_max_height', downloadDays: 'download_days', remoteMaxBitrate: 'remote_max_bitrate',
} as const satisfies Partial<Record<TemplateKey, string>>;
export type LegacyKey = keyof typeof LEGACY_COLUMNS;

/**
 * The legacy role editor (PUT /api/admin/roles/:role until the role matrix replaces it) writes the old role_settings columns: this
 * copies the given fields from their columns into `template` with migration 47's mapping (null = inherit, removed from the template;
 * max_height 0 = unlimited, JSON null). Other template keys stay.
 */
export async function mirrorLegacyColumns(ctx: Pick<Ctx, 'db'>, role: string, keys: readonly LegacyKey[] = Object.keys(LEGACY_COLUMNS) as LegacyKey[]): Promise<void> {
  if (!keys.length) return;
  const row = (await ctx.db.query<Record<string, unknown>>(`select ${keys.map((k) => LEGACY_COLUMNS[k]).join(', ')} from role_settings where role=$1`, [role])).rows[0];
  if (!row) return;
  const set: Record<string, unknown> = {};
  const drop: string[] = [];
  for (const k of keys) {
    const v = row[LEGACY_COLUMNS[k]];
    if (v === null) drop.push(k);
    else set[k] = k === 'maxHeight' && v === 0 ? null : v;
  }
  await ctx.db.query('update role_settings set template = (template - $2::text[]) || $3::jsonb where role=$1', [role, drop, JSON.stringify(set)]);
}

/** bitrate ceiling for a viewer outside the home networks: the remote cap, never above the role's own limit */
export const remoteBitrateCap = (role: Pick<RoleTemplate, 'maxBitrate' | 'remoteMaxBitrate'>) => Math.min(role.maxBitrate, role.remoteMaxBitrate);
/** forgets the cached role settings and the role catalogue (rolecat.ts) of this ctx */
export const invalidateRoles = (ctx: object) => { cache.delete(ctx); invalidateCatalogue(ctx); };

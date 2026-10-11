import { z } from 'zod';

export const roleTemplateSchema = z.object({
  label: z.string(),
  /** 'all' or library (media folder) names */
  libraries: z.union([z.literal('all'), z.array(z.string())]),
  /** Jellyfin MaxParentalRating (e.g. 12). null = unrestricted */
  maxParentalRating: z.number().int().nullable(),
  /** bits per second */
  maxBitrate: z.number().int().positive(),
  maxStreams: z.number().int().positive(),
  transcoding: z.boolean(),
  /** max video height in px (playback is capped/transcoded down to it). null = no cap */
  maxHeight: z.number().int().positive().nullable(),
  download: z.boolean(),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;

export const DEFAULT_ROLES: Record<string, RoleTemplate> = {
  friend: { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20_000_000, maxStreams: 2, transcoding: true, maxHeight: null, download: false },
  family: { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40_000_000, maxStreams: 4, transcoding: true, maxHeight: null, download: true },
  guest: { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8_000_000, maxStreams: 1, transcoding: true, maxHeight: 1080, download: false },
  admin: { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60_000_000, maxStreams: 6, transcoding: true, maxHeight: null, download: true },
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
const cache = new WeakMap<object, { at: number; rows: Map<string, { transcoding: boolean | null; maxHeight: number | null }> }>();

/** Code default <- ROLE_TEMPLATES env (ctx.roles) <- role_settings row (admin UI). Cached ~30 s per ctx; max_height 0 = unlimited. */
export async function effectiveRole(ctx: { roles: Record<string, RoleTemplate>; db: { query: (q: string) => Promise<{ rows: any[] }> } }, role: string): Promise<RoleTemplate | undefined> {
  const base = ctx.roles[role];
  if (!base) return undefined;
  let c = cache.get(ctx);
  if (!c || Date.now() - c.at > TTL_MS) {
    const r = await ctx.db.query('select role, transcoding, max_height from role_settings');
    c = { at: Date.now(), rows: new Map(r.rows.map((x) => [x.role as string, { transcoding: x.transcoding, maxHeight: x.max_height }])) };
    cache.set(ctx, c);
  }
  const o = c.rows.get(role);
  if (!o) return base;
  return { ...base, transcoding: o.transcoding ?? base.transcoding, maxHeight: o.maxHeight === null ? base.maxHeight : o.maxHeight === 0 ? null : o.maxHeight };
}
export const invalidateRoles = (ctx: object) => void cache.delete(ctx);

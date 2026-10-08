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
  download: z.boolean(),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;

export const DEFAULT_ROLES: Record<string, RoleTemplate> = {
  friend: { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20_000_000, maxStreams: 2, transcoding: true, download: false },
  family: { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40_000_000, maxStreams: 4, transcoding: true, download: true },
  guest: { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8_000_000, maxStreams: 1, transcoding: false, download: false },
  admin: { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60_000_000, maxStreams: 6, transcoding: true, download: true },
};

export const INVITABLE_ROLES = ['friend', 'family', 'guest'] as const;

export function loadRoles(overrideJson?: string): Record<string, RoleTemplate> {
  if (!overrideJson) return DEFAULT_ROLES;
  const o = z.record(roleTemplateSchema.partial()).parse(JSON.parse(overrideJson));
  const out: Record<string, RoleTemplate> = { ...DEFAULT_ROLES };
  for (const [k, v] of Object.entries(o)) out[k] = { ...(DEFAULT_ROLES[k] ?? DEFAULT_ROLES.friend!), ...v } as RoleTemplate;
  return out;
}

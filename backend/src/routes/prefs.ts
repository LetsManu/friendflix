import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { requireUser } from '../session.js';

export const prefsSchema = z.object({
  autoplayNext: z.boolean().default(true),
  autoSkipIntro: z.boolean().default(false),
  /** ISO 639-2 codes as Jellyfin reports them (ger, eng, ...); '' = keep the file's default */
  audioLang: z.string().regex(/^[a-z]{0,3}$/).default(''),
  /** '' = subtitles off by default */
  subtitleLang: z.string().regex(/^[a-z]{0,3}$/).default(''),
  /** friends may include my unwatched list in the group matcher (opt-in, default off) */
  shareHistory: z.boolean().default(false),
  /** my ratings may appear in "Freunde haben bewertet" (default on) */
  shareRatings: z.boolean().default(true),
  /** short muted trailer preview when hovering a card (only local trailers) */
  hoverTrailers: z.boolean().default(true),
  /** no local trailer? preview a short clip of the film itself (pre-generated once and cached as a plain MP4, so cheap) */
  hoverClip: z.boolean().default(true),
  /** 0 = automatic, else a bitrate in bit/s (capped by the role limit on the server) */
  quality: z.number().int().min(0).max(200_000_000).default(0),
  /** "Schaust du noch?" check before autoplaying further episodes */
  stillWatching: z.boolean().default(true),
  /** ask after this many episodes in a row without interaction */
  stillWatchingEpisodes: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(3),
  subtitleStyle: z.object({
    size: z.enum(['s', 'm', 'l', 'xl']).default('m'),
    color: z.enum(['white', 'yellow', 'cyan', 'green']).default('white'),
    background: z.enum(['none', 'shadow', 'semi', 'solid']).default('semi'),
    font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  }).default({ size: 'm', color: 'white', background: 'semi', font: 'sans' }),
  /** blur thumbnails and hide descriptions of unwatched episodes */
  spoilerProtection: z.boolean().default(false),
});
export type Prefs = z.infer<typeof prefsSchema>;

export async function loadPrefs(ctx: Pick<Ctx, 'db'>, userId: string): Promise<Prefs> {
  const r = await ctx.db.query<{ data: unknown }>('select data from user_prefs where user_id=$1', [userId]);
  const parsed = prefsSchema.safeParse(r.rows[0]?.data ?? {});
  return parsed.success ? parsed.data : prefsSchema.parse({});
}

export function prefsRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  const load = async (userId: string): Promise<Prefs> => {
    const r = await ctx.db.query<{ data: unknown }>('select data from user_prefs where user_id=$1', [userId]);
    const parsed = prefsSchema.safeParse(r.rows[0]?.data ?? {});
    return parsed.success ? parsed.data : prefsSchema.parse({});
  };
  app.get('/api/prefs', pre, async (req) => ({ prefs: await load(req.user!.id) }));
  app.put('/api/prefs', pre, async (req) => {
    const prefs = prefsSchema.parse(req.body);
    await ctx.db.query(
      `insert into user_prefs(user_id, data) values ($1,$2) on conflict (user_id) do update set data = excluded.data, updated_at = now()`,
      [req.user!.id, JSON.stringify(prefs)],
    );
    return { prefs };
  });
}

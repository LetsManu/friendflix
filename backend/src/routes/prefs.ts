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
  /** 0 = automatic, else a bitrate in bit/s (capped by the role limit on the server) */
  quality: z.number().int().min(0).max(200_000_000).default(0),
});
export type Prefs = z.infer<typeof prefsSchema>;

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

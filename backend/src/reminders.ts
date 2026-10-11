import type { Ctx } from './ctx.js';
import { notify } from './notify.js';
import type { JfUser, UserRow } from './types.js';

type Db = Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>;

interface ReminderRow {
  id: string;
  user_id: string;
  kind: 'tmdb' | 'episode';
  media_type: 'movie' | 'tv' | null;
  tmdb_id: number | null;
  jf_item_id: string | null;
  title: string;
}

/** Marks the reminder as fired; false = somebody else (webhook, tick, hook) was faster. */
async function claim(ctx: Db, id: string): Promise<boolean> {
  const r = await ctx.db.query('update reminders set fired_at = now() where id = $1 and fired_at is null returning id', [id]);
  return (r.rowCount ?? 0) > 0;
}

/** A real (non-placeholder) episode: Jellyfin lists announced episodes as Virtual / missing. */
export async function isAvailableEpisode(ctx: Pick<Ctx, 'jf'>, user: JfUser, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: ids.join(','), isMissing: 'false', recursive: 'true', includeItemTypes: 'Episode', fields: 'LocationType' });
  const r = await ctx.jf.json<{ Items?: Array<{ Id: string; LocationType?: string }> }>(user, `/Items?${p}`);
  for (const i of r.Items ?? []) if (i.LocationType !== 'Virtual') out.add(i.Id);
  return out;
}

/** A movie / series with this TMDB id is now in the library: notify everybody who asked to be reminded (once). */
export async function fireTmdb(ctx: Db & Pick<Ctx, 'jf'>, mediaType: string, tmdbId: number, jfItemId?: string): Promise<number> {
  if (mediaType !== 'movie' && mediaType !== 'tv') return 0;
  const rows = (await ctx.db.query<ReminderRow>(
    `select r.* from reminders r join users u on u.id = r.user_id
      where r.kind = 'tmdb' and r.media_type = $1 and r.tmdb_id = $2 and r.fired_at is null and not u.disabled`,
    [mediaType, tmdbId],
  )).rows;
  if (!rows.length) return 0;
  const itemId = jfItemId ?? (await ctx.jf.findByTmdb(tmdbId, mediaType).catch(() => null))?.id;
  let sent = 0;
  for (const r of rows) {
    if (!(await claim(ctx, r.id))) continue;
    // the requester already gets "avail-<seerr request id>" for the same title: one notification is enough
    const req = await ctx.db.query('select 1 from seerr_requests where user_id = $1 and tmdb_id = $2 and media_type = $3', [r.user_id, tmdbId, mediaType]);
    if (req.rowCount) continue;
    const ok = await notify(ctx, {
      userId: r.user_id, kind: 'reminder', title: `„${r.title}“ ist jetzt verfügbar`, link: itemId ? `/item/${itemId}` : '/',
      dedupe: `remind-${r.user_id}-${mediaType}-${tmdbId}`, personal: true,
    });
    if (ok) sent++;
  }
  return sent;
}

async function fireEpisodeRow(ctx: Db, r: ReminderRow): Promise<boolean> {
  if (!(await claim(ctx, r.id))) return false;
  // same key as the follow job (calendarNotifications): followers get exactly one notification
  return notify(ctx, { userId: r.user_id, kind: 'episode', title: `Neue Folge: ${r.title}`, link: `/watch/${r.jf_item_id}`, dedupe: `cal-${r.user_id}-${r.jf_item_id}`, personal: true });
}

/** Jellyfin webhook ItemAdded for an episode: fires the reminders of every user waiting for it. */
export async function fireEpisode(ctx: Db, jfItemId: string): Promise<number> {
  const rows = (await ctx.db.query<ReminderRow>(
    `select r.* from reminders r join users u on u.id = r.user_id where r.kind = 'episode' and r.jf_item_id = $1 and r.fired_at is null and not u.disabled`,
    [jfItemId],
  )).rows;
  let n = 0;
  for (const r of rows) if (await fireEpisodeRow(ctx, r)) n++;
  return n;
}

let busy = false;

/** Every 30 min: safety net for missed webhooks (TMDB titles via findByTmdb, episodes via Jellyfin) + cleanup. */
export async function reminderTick(ctx: Ctx): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const pairs = (await ctx.db.query<{ media_type: string; tmdb_id: number }>(
      "select media_type, tmdb_id from reminders where kind='tmdb' and fired_at is null group by media_type, tmdb_id order by random() limit 50",
    )).rows;
    for (const p of pairs) {
      try {
        const hit = await ctx.jf.findByTmdb(p.tmdb_id, p.media_type);
        if (hit) await fireTmdb(ctx, p.media_type, p.tmdb_id, hit.id);
      } catch (e) {
        console.error('reminder tmdb check failed', e);
      }
    }
    const eps = (await ctx.db.query<ReminderRow>(
      `select r.* from reminders r join users u on u.id = r.user_id where r.kind = 'episode' and r.fired_at is null and not u.disabled order by r.user_id, r.id`,
    )).rows;
    const byUser = new Map<string, ReminderRow[]>();
    for (const r of eps) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    for (const [userId, list] of byUser) {
      try {
        const user = (await ctx.db.query<UserRow>('select * from users where id = $1', [userId])).rows[0];
        if (!user) continue;
        for (let i = 0; i < list.length; i += 50) {
          const chunk = list.slice(i, i + 50);
          const ok = await isAvailableEpisode(ctx, user, chunk.map((r) => r.jf_item_id!));
          for (const r of chunk) if (ok.has(r.jf_item_id!)) await fireEpisodeRow(ctx, r);
        }
      } catch (e) {
        console.error('reminder episode check failed', e);
      }
    }
    await ctx.db.query("delete from reminders where fired_at < now() - interval '30 days'");
  } finally {
    busy = false;
  }
}

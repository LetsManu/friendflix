import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { randomToken } from './crypto.js';
import type { Ctx } from './ctx.js';
import { notify } from './notify.js';
import { parties } from './routes/party.js';
import { ensureSeerrUser } from './seerr/service.js';
import { getUserById } from './users.js';

export interface OptionInput {
  jfItemId?: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
}

export async function createPoll(ctx: Ctx, creatorId: string, input: { title: string; options: OptionInput[]; closesInMinutes: number; startsAfterMinutes: number }) {
  const creator = (await getUserById(ctx, creatorId))!;
  const resolved: Array<{ jf?: string; tmdb?: number; type?: string; title: string; poster?: string }> = [];
  for (const o of input.options) {
    if (o.jfItemId) {
      const it = await ctx.jf.item(creator, o.jfItemId); // also verifies the creator can see it
      resolved.push({ jf: it.id, title: it.name });
    } else if (o.tmdbId && o.mediaType) {
      const d = await ctx.seerr.details(o.mediaType, o.tmdbId);
      const inLib = await ctx.jf.findByTmdb(o.tmdbId, o.mediaType).catch(() => null);
      if (inLib) resolved.push({ jf: inLib.id, title: inLib.name }); // already in library -> plain library option
      else resolved.push({ tmdb: o.tmdbId, type: o.mediaType, title: String(d.title ?? d.name), poster: d.posterPath ?? undefined });
    }
  }
  const closes = new Date(Date.now() + input.closesInMinutes * 60_000);
  const starts = new Date(closes.getTime() + input.startsAfterMinutes * 60_000);
  const id = randomUUID();
  await ctx.db.query('insert into polls(id,title,created_by,closes_at,starts_at) values ($1,$2,$3,$4,$5)', [id, input.title, creatorId, closes, starts]);
  for (const r of resolved) {
    await ctx.db.query('insert into poll_options(poll_id,jf_item_id,tmdb_id,media_type,title,poster) values ($1,$2,$3,$4,$5,$6)', [id, r.jf ?? null, r.tmdb ?? null, r.type ?? null, r.title, r.poster ?? null]);
  }
  await audit(ctx, creatorId, 'poll.create', id, { title: input.title });
  await notify(ctx, { userId: null, kind: 'poll_open', title: `Filmabend-Abstimmung: ${input.title}`, link: `/vote`, dedupe: `poll-open-${id}`, external: true });
  return id;
}

async function adminIds(ctx: Ctx): Promise<string[]> {
  return (await ctx.db.query<{ id: string }>("select id from users where role='admin' and not disabled")).rows.map((r) => r.id);
}

function schedule(ctx: Ctx, pollId: string, title: string, itemId: string, hostId: string, startAt: Date, roomId?: string | null) {
  const id = roomId ?? randomToken(9);
  if (!parties.get(id)) parties.create({ id, itemId, title, hostId, startAt: Math.max(startAt.getTime(), Date.now() + 5000) });
  void pollId;
  void ctx;
  return id;
}

/** Closes due polls, schedules winners with a party room (auto-start) or asks the admin for approval. */
export async function closeDuePolls(ctx: Ctx) {
  const due = (await ctx.db.query("select * from polls where status='open' and closes_at <= now()")).rows;
  for (const p of due) {
    const win = (await ctx.db.query(
      `select o.*, count(v.user_id) votes from poll_options o left join poll_votes v on v.option_id = o.id
        where o.poll_id=$1 group by o.id order by votes desc, o.id asc limit 1`,
      [p.id],
    )).rows[0];
    if (!win || Number(win.votes) === 0) {
      await ctx.db.query("update polls set status='cancelled' where id=$1", [p.id]);
      await notify(ctx, { userId: null, kind: 'poll_cancelled', title: `Abstimmung ohne Stimmen beendet: ${p.title}`, dedupe: `poll-cancel-${p.id}` });
      continue;
    }
    await ctx.db.query('update polls set winner_option_id=$1 where id=$2', [win.id, p.id]);
    if (win.jf_item_id) {
      const room = schedule(ctx, p.id, win.title, win.jf_item_id, p.created_by, p.starts_at);
      await ctx.db.query("update polls set status='scheduled', room_id=$1 where id=$2", [room, p.id]);
      await notify(ctx, { userId: null, kind: 'poll_scheduled', title: `Filmabend steht fest: ${win.title}`, body: `Start ${new Date(p.starts_at).toLocaleString('de-DE')}`, link: `/party/${room}`, dedupe: `poll-sched-${p.id}`, external: true });
    } else {
      await ctx.db.query("update polls set status='needs_approval' where id=$1", [p.id]);
      for (const a of await adminIds(ctx)) {
        await notify(ctx, { userId: a, kind: 'poll_needs_approval', title: `Freigabe nötig: „${win.title}“ hat die Abstimmung gewonnen`, link: '/admin/polls', dedupe: `poll-appr-${p.id}-${a}`, external: true });
      }
    }
  }
}

export async function approvePoll(ctx: Ctx, pollId: string, adminId: string, approve: boolean) {
  const p = (await ctx.db.query("select * from polls where id=$1 and status='needs_approval'", [pollId])).rows[0];
  if (!p) return false;
  if (!approve) {
    await ctx.db.query("update polls set status='cancelled' where id=$1", [pollId]);
    await audit(ctx, adminId, 'poll.reject', pollId);
    return true;
  }
  const opt = (await ctx.db.query('select * from poll_options where id=$1', [p.winner_option_id])).rows[0];
  const creator = (await getUserById(ctx, p.created_by))!;
  const seerrUser = await ensureSeerrUser(ctx, creator);
  const created = await ctx.seerr.createRequest({ mediaType: opt.media_type, mediaId: opt.tmdb_id, seasons: opt.media_type === 'tv' ? 'all' : undefined, userId: seerrUser });
  await ctx.db.query('insert into seerr_requests(seerr_request_id,user_id,media_type,tmdb_id,title,poster) values ($1,$2,$3,$4,$5,$6) on conflict (seerr_request_id) do nothing', [created.id, creator.id, opt.media_type, opt.tmdb_id, opt.title, opt.poster]);
  await ctx.seerr.approve(created.id).catch(() => undefined); // admin approval of the poll = approval of the request
  await ctx.db.query("update polls set status='requested', seerr_request_id=$1 where id=$2", [created.id, pollId]);
  await audit(ctx, adminId, 'poll.approve', pollId, { seerrRequest: created.id });
  await notify(ctx, { userId: null, kind: 'poll_requested', title: `„${opt.title}“ wurde angefragt – Filmabend startet, sobald es verfügbar ist`, link: '/vote', dedupe: `poll-req-${pollId}`, external: true });
  return true;
}

/** Requested titles that became available in the library are scheduled automatically (start in 30 min). */
export async function resolveRequestedPolls(ctx: Ctx) {
  const rows = (await ctx.db.query("select p.*, o.tmdb_id, o.media_type, o.title otitle from polls p join poll_options o on o.id=p.winner_option_id where p.status='requested'")).rows;
  for (const p of rows) {
    const found = await ctx.jf.findByTmdb(p.tmdb_id, p.media_type).catch(() => null);
    if (!found) continue;
    const startsAt = new Date(Math.max(Date.now() + 30 * 60_000, new Date(p.starts_at).getTime()));
    const room = schedule(ctx, p.id, p.otitle, found.id, p.created_by, startsAt);
    await ctx.db.query("update polls set status='scheduled', room_id=$1, starts_at=$2 where id=$3", [room, startsAt, p.id]);
    await ctx.db.query('update poll_options set jf_item_id=$1 where id=$2', [found.id, p.winner_option_id]);
    await notify(ctx, { userId: null, kind: 'poll_scheduled', title: `Filmabend steht fest: ${p.otitle}`, body: `Start ${startsAt.toLocaleString('de-DE')}`, link: `/party/${room}`, dedupe: `poll-sched-${p.id}`, external: true });
  }
}

/** Maintenance tick: closes polls, restores rooms lost on restart, marks started polls. */
export async function pollTick(ctx: Ctx) {
  await closeDuePolls(ctx);
  const sched = (await ctx.db.query("select p.*, o.jf_item_id, o.title otitle from polls p join poll_options o on o.id=p.winner_option_id where p.status='scheduled'")).rows;
  for (const p of sched) {
    if (!parties.get(p.room_id)) {
      if (Date.now() - new Date(p.starts_at).getTime() > 6 * 3600_000) await ctx.db.query("update polls set status='started' where id=$1", [p.id]);
      else schedule(ctx, p.id, p.otitle, p.jf_item_id, p.created_by, new Date(p.starts_at), p.room_id);
    } else if (new Date(p.starts_at).getTime() <= Date.now()) {
      await ctx.db.query("update polls set status='started' where id=$1", [p.id]);
    }
  }
}

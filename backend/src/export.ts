// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Download my data" (GET /api/account/export): one JSON document with everything FriendFlix keeps about the account, built on
 * demand and yielded section by section so the route can stream it.
 *
 * Every query names its columns (an allowlist: a column added later never leaks by accident) and reads only the account's own
 * rows. Never exported: other people's ids, names or notes (a list item a member added is listed as `addedByMe: false`; of a
 * list the user is only a member of, only its name and the user's own items), device ids, push endpoints/keys, the ntfy topic
 * (it works like a password), PIN hashes, the Authentik subject and any media server credential.
 */
import type { Ctx } from './ctx.js';
import { jfUserFor } from './profiles.js';
import { loadPrefs } from './routes/prefs.js';
import { requestStateKey, SeerrError } from './seerr/client.js';
import type { ProfileRow, UserRow } from './types.js';

/** media server history per profile (newest first) */
const HISTORY_LIMIT = 1000;

/** the profile columns the export needs; the media server identity is used for the history call only and never written out */
type ExportProfile = Pick<ProfileRow, 'id' | 'name' | 'avatar' | 'kids' | 'kids_max_rating' | 'is_owner' | 'created_at' | 'jellyfin_user_id' | 'jellyfin_username' | 'jellyfin_pw_enc'>;

export async function* exportUserData(ctx: Ctx, user: UserRow): AsyncGenerator<string> {
  const uid = user.id;
  const q = async <T>(sql: string, p: unknown[] = [uid]) => (await ctx.db.query(sql, p)).rows as T[];
  const field = (key: string, value: unknown) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`;

  yield `{"format":"friendflix-export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())}`;

  // UserRow carries neither avatar nor access_until: read them here
  const acc = (await q<{ avatar: string | null; access_until: Date | null }>('select avatar, access_until from users where id=$1'))[0];
  yield field('account', {
    id: uid, name: user.name, email: user.email, role: user.role, avatar: acc?.avatar ?? null, createdAt: user.created_at, accessUntil: acc?.access_until ?? null,
  });

  const profiles = await q<ExportProfile>(
    `select id, name, avatar, kids, kids_max_rating, is_owner, created_at, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc
       from profiles where user_id=$1 order by is_owner desc, created_at, name`);
  yield field('profiles', profiles.map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, kids: p.kids, maxRating: p.kids ? p.kids_max_rating : null, isOwner: p.is_owner, createdAt: p.created_at,
  })));

  // owned lists in full (items of members only as "not by me"); member lists: name + own items only, no owner, no members
  const lists = await q<{ id: string; name: string; description: string | null; themed: boolean; emoji: string | null; cover_color: string | null; created_at: Date; owned: boolean }>(
    `select id, name, description, themed, emoji, cover_color, created_at, true owned from lists where owner_id=$1
     union all
     select l.id, l.name, null, null, null, null, null, false from lists l join list_members m on m.list_id=l.id and m.user_id=$1
     order by owned desc, name`);
  const items = lists.length ? await q<{ list_id: string; item_id: string; item_name: string; note: string | null; mine: boolean; added_at: Date }>(
    `select i.list_id, i.item_id, i.item_name, case when i.added_by=$1 then i.note end note, coalesce(i.added_by=$1, false) mine, i.added_at
       from list_items i where i.list_id = any($2) and (i.added_by=$1 or exists (select 1 from lists l where l.id=i.list_id and l.owner_id=$1))
      order by i.added_at`, [uid, lists.map((l) => l.id)]) : [];
  yield field('lists', lists.map((l) => {
    const own = items.filter((i) => i.list_id === l.id).map((i) => ({ itemId: i.item_id, name: i.item_name, ...(i.note ? { note: i.note } : {}), addedAt: i.added_at, addedByMe: i.mine }));
    return l.owned
      ? { name: l.name, owned: true, description: l.description, themed: l.themed, emoji: l.emoji, coverColor: l.cover_color, createdAt: l.created_at, items: own }
      : { name: l.name, owned: false, items: own };
  }));

  yield field('watchlist', {
    items: (await q<{ profile_id: string; item_id: string; added_at: Date }>('select profile_id, item_id, added_at from watchlist where user_id=$1 order by added_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, addedAt: r.added_at })),
    bookmarks: (await q<{ profile_id: string; item_id: string; item_name: string; position_sec: number; note: string | null; created_at: Date }>(
      'select profile_id, item_id, item_name, position_sec, note, created_at from bookmarks where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, name: r.item_name, positionSeconds: r.position_sec, note: r.note, createdAt: r.created_at })),
    reminders: (await q<{ profile_id: string | null; kind: string; media_type: string | null; tmdb_id: number | null; jf_item_id: string | null; series_id: string | null; season: number | null; episode: number | null; title: string; release_date: string | null; created_at: Date; fired_at: Date | null }>(
      `select profile_id, kind, media_type, tmdb_id, jf_item_id, series_id, season, episode, title, release_date::text, created_at, fired_at
         from reminders where user_id=$1 order by created_at`))
      .map((r) => ({
        profileId: r.profile_id, kind: r.kind, mediaType: r.media_type, tmdbId: r.tmdb_id, itemId: r.jf_item_id, seriesId: r.series_id, season: r.season, episode: r.episode,
        title: r.title, releaseDate: r.release_date, createdAt: r.created_at, firedAt: r.fired_at,
      })),
    seriesFollows: (await q<{ series_id: string; series_name: string }>('select series_id, series_name from series_follows where user_id=$1 order by series_name'))
      .map((r) => ({ seriesId: r.series_id, name: r.series_name })),
  });

  yield field('ratings', {
    stars: (await q<{ item_id: string; item_name: string; stars: number; review: string | null; created_at: Date }>(
      'select item_id, item_name, stars, review, created_at from ratings where user_id=$1 order by created_at'))
      .map((r) => ({ itemId: r.item_id, name: r.item_name, stars: r.stars, review: r.review, createdAt: r.created_at })),
    thumbs: (await q<{ profile_id: string; item_id: string; item_name: string; value: number; created_at: Date }>(
      'select profile_id, item_id, item_name, value, created_at from thumbs where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, name: r.item_name, value: r.value, createdAt: r.created_at })),
    reactions: (await q<{ profile_id: string; item_id: string; emoji: string; comment: string | null; created_at: Date }>(
      'select profile_id, item_id, emoji, comment, created_at from reactions where user_id=$1 order by created_at'))
      .map((r) => ({ profileId: r.profile_id, itemId: r.item_id, reaction: r.emoji, comment: r.comment, createdAt: r.created_at })),
  });

  // local watch statistics (own rows only); play_daily is summed over devices, so no device id leaves the server
  const totals = {
    perItem: (await q<{ item_id: string; item_name: string; item_type: string | null; series_name: string | null; seconds: string; first_day: string; last_day: string }>(
      `select item_id, max(item_name) item_name, max(item_type) item_type, max(series_name) series_name, sum(seconds) seconds, min(day)::text first_day, max(day)::text last_day
         from play_seconds where user_id=$1 group by item_id order by max(day) desc, item_id`))
      .map((r) => ({ itemId: r.item_id, name: r.item_name, type: r.item_type, seriesName: r.series_name, seconds: Number(r.seconds), firstDay: r.first_day, lastDay: r.last_day })),
    perDay: (await q<{ day: string; streams: string; transcodes: string }>(
      'select day::text, sum(streams) streams, sum(transcodes) transcodes from play_daily where user_id=$1 group by day order by day'))
      .map((r) => ({ day: r.day, streams: Number(r.streams), transcodes: Number(r.transcodes) })),
  };
  // the media server's history as each profile; one failure marks the section unavailable, the rest of the export goes on
  const history = await Promise.all(profiles.map(async (p) => ({
    profileId: p.id,
    items: (await ctx.jf.history(jfUserFor(user, p as ProfileRow), { limit: HISTORY_LIMIT })).map((i) => ({
      itemId: i.id, name: i.name, type: i.type, ...(i.seriesName ? { seriesName: i.seriesName } : {}),
      playedAt: i.lastPlayedDate ?? null, positionSeconds: Math.floor(i.positionTicks / 10_000_000), played: i.played,
    })),
  }))).then((ps) => ({ profiles: ps, totals }), () => ({ error: 'unavailable', totals }));
  yield field('history', history);

  // request state from the request service; a removed request reads 'removed', an unreachable service 'unknown' (asked once)
  const reqs = await q<{ seerr_request_id: number; tmdb_id: number; media_type: string; title: string; created_at: Date }>(
    'select seerr_request_id, tmdb_id, media_type, title, created_at from seerr_requests where user_id=$1 order by created_at');
  let reachable = true;
  const requests = [];
  for (const r of reqs) {
    let status = 'unknown';
    if (reachable) {
      try {
        const sr = await ctx.seerr.getRequest(r.seerr_request_id);
        status = requestStateKey(sr?.media?.status, sr?.status);
      } catch (e) {
        if (e instanceof SeerrError && e.status === 404) status = 'removed';
        else reachable = false;
      }
    }
    requests.push({ tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title, status, createdAt: r.created_at });
  }
  yield field('requests', requests);

  yield field('devices', (await q<{ label: string; approved: boolean; created_at: Date; last_seen: Date }>(
    'select label, approved, created_at, last_seen from devices where user_id=$1 order by created_at'))
    .map((d) => ({ label: d.label, approved: d.approved, createdAt: d.created_at, lastSeen: d.last_seen })));

  // notification settings are account level (user_prefs); the ntfy topic is a secret, so only whether one is set
  const prefs = await loadPrefs(ctx, uid);
  const push = (await q<{ n: string }>('select count(*) n from push_subscriptions where user_id=$1'))[0]!;
  const notes = await q<{ kind: string; title: string; created_at: Date; read: boolean }>(
    'select kind, title, created_at, read_at is not null read from notifications where user_id=$1 order by created_at desc');
  yield field('notifications', {
    weeklyDigest: prefs.weeklyDigest, ntfyTopicSet: prefs.ntfyTopic !== '', pushSubscriptions: Number(push.n),
    items: notes.map((n) => ({ kind: n.kind, title: n.title, createdAt: n.created_at, read: n.read })),
  });
  yield '}';
}

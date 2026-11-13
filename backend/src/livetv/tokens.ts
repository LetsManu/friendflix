// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { AIRPLAY_PIN2_WINDOW_MS, CAST_TOKEN_RE, hashToken, takePin } from '../cast.js';
import type { Ctx } from '../ctx.js';
import { clearLive, getLive, setLive } from '../live.js';
import { getProfile } from '../profiles.js';
import { effectiveRole } from '../roles.js';
import { getUserById } from '../users.js';
import { channelAllowed } from './rights.js';

/**
 * Live TV tokens (spec §7.1), modelled on the cast tokens (cast.ts): an opaque credential in the gateway path `/media/l/<token>/…`,
 * because a TV, a Chromecast or an AirPlay receiver fetches the stream without the user's cookie.
 *
 * - The raw token exists only in the watch answer and the gateway's request path. KV holds sha256(token) only (keys and values):
 *   `ltv:<hash>` the record (sliding LIVE_IDLE_TTL_S, absolute cap LIVE_CAP_S), `ltvidx:<userId>` the account's index (members =
 *   hashes), `ltvpin:` / `ltvpin2:` the pinned client addresses, `ltv:view:<hash>` the viewer key (VIEW_TTL_S, value = channel id;
 *   Task 31's viewerCounts), `ltvgone:<hash>` the revocation marker (10 min: a revoked token answers 410, an unknown one 401).
 * - Pins (the cast rules): the first client address pins; `chromecast` one address; `airplay` a second address within
 *   AIRPLAY_PIN2_WINDOW_MS of the mint; a `local` token re-pins through a beat of the session that minted it (a phone moving from
 *   Wi-Fi to mobile data, Review Focus 4). Nothing else ever moves a pin.
 * - Every authz re-checks the account (enabled, role known), the profile, the device approval and the channel right
 *   (`channelAllowed`; a `test` token instead: current role admin and the channel present in an enabled source, F10), memoised 2 s
 *   per token; revocation (marker + key removal) is seen at once.
 * - Never logged, never in metrics labels, error texts or Diagnose.
 */
export const LIVE_IDLE_TTL_S = 90;
export const LIVE_TOUCH_MS = 20_000;
export const LIVE_CAP_S = 12 * 3600;
export const MAX_LIVE_TOKENS = 4;
export const VIEW_TTL_S = 45;
/** how long a rights decision of a token is reused (spec §7.1 "memo 2 s"); also the gateway's memo of an authz answer (`maxAgeS`) */
export const LIVE_RIGHTS_MEMO_MS = 2_000;
export const LIVE_AUTHZ_MAX_AGE_S = 2;
/** a revoked token answers 410 (not 401) this long, so the player re-requests watch once instead of giving up */
export const LIVE_GONE_TTL_S = 600;

export interface LiveTokenRec {
  userId: string;
  profileId: string;
  deviceId: string;
  /** sha256 of the session id that minted the token (liveSidHash): only a beat of that session re-pins a `local` token */
  sidHash: string;
  channelId: string;
  channelName: string;
  kind: 'live';
  via: 'local' | 'chromecast' | 'airplay';
  remote: boolean;
  /** admin stream-test preview (F10): no channel right and no release check, but the current role must be admin */
  test?: true;
  /** epoch ms, absolute cap */
  exp: number;
  createdAt: number;
}
/** as stored: plus the epoch ms of the last sliding refresh by an authz (absent until the first resolve) */
interface StoredRec extends LiveTokenRec { seen?: number }

const dataKey = (hash: string) => `ltv:${hash}`;
const pinKey = (hash: string) => `ltvpin:${hash}`;
const pin2Key = (hash: string) => `ltvpin2:${hash}`;
const goneKey = (hash: string) => `ltvgone:${hash}`;
const idxKey = (userId: string) => `ltvidx:${userId}`;
/** the viewer key of a token (spec §7.4): exists while the token was touched within VIEW_TTL_S; value = its channel id */
export const liveViewKey = (hash: string) => `ltv:view:${hash}`;
/** the play session of a token's live record (ruling 21) */
export const livePlaySessionId = (hash: string) => `ltv-${hash.slice(0, 24)}`;
/** the session binding stored in a token (never the session id itself) */
export const liveSidHash = (sid: string) => hashToken(sid);

/** KV TTL of a token's record: the idle window, never past the absolute cap (0 = over) */
const keyTtl = (exp: number, now = Date.now()) => Math.max(0, Math.min(LIVE_IDLE_TTL_S, Math.ceil((exp - now) / 1000)));
/** pins live as long as the token can (removed on revoke) */
const pinTtl = (exp: number, now = Date.now()) => Math.max(1, Math.ceil((exp - now) / 1000));

const parse = (raw: string | null): StoredRec | null => (raw ? (JSON.parse(raw) as StoredRec) : null);
const load = async (ctx: Pick<Ctx, 'kv'>, hash: string) => parse(await ctx.kv.get(dataKey(hash)));

/** older first: by mint time, ties by hash (two mints in the same millisecond still order the same way everywhere) */
const older = (a: { hash: string; rec: LiveTokenRec }, b: { hash: string; rec: LiveTokenRec }) =>
  a.rec.createdAt - b.rec.createdAt || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/** the account's tokens that still exist (stale index members are dropped on the way) */
async function listTokens(ctx: Pick<Ctx, 'kv'>, userId: string): Promise<Array<{ hash: string; rec: StoredRec }>> {
  const out: Array<{ hash: string; rec: StoredRec }> = [];
  for (const hash of await ctx.kv.indexMembers(idxKey(userId))) {
    const rec = await load(ctx, hash);
    if (rec && rec.userId === userId) out.push({ hash, rec });
    else await ctx.kv.indexRemove(idxKey(userId), hash);
  }
  return out;
}

/** the replacement slot class of a token's `via` (R14): a Chromecast token is a `cast`; local and AirPlay views are `local` */
const viaClass = (via: LiveTokenRec['via']): 'cast' | 'local' => (via === 'chromecast' ? 'cast' : 'local');

/** token hash -> the owner's display names while account, role, profile, device and the channel right hold (null = refused) */
const rightsMemo = new Map<string, { exp: number; v: { userName: string; profileName: string } | null }>();

/**
 * Mints a live token (32 random bytes, base64url). The same device's earlier tokens of the same slot are revoked (a channel switch;
 * spec §7.1). A slot is (normal or admin test, cast or local): a stream-test preview never ends a live view on that device, nor the
 * reverse (R8), and a cast (`chromecast`) never replaces the device's own local view, nor the reverse (R14); `local` and `airplay`
 * share the local slot. At
 * most MAX_LIVE_TOKENS stay per account (the oldest go); both are enforced after the insert, so simultaneous mints converge instead of
 * racing past the limit. Seeds the viewer key at once (F9): a viewer who has not fetched a file yet already counts. Returns the raw
 * token (once) and its hash.
 */
export async function mintLiveToken(ctx: Ctx, rec: Omit<LiveTokenRec, 'exp' | 'createdAt'>): Promise<{ token: string; hash: string; expiresAt: number }> {
  const now = Date.now();
  const exp = now + LIVE_CAP_S * 1000;
  const token = randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  const { test, ...rest } = rec;
  const full: LiveTokenRec = { ...rest, ...(test === true ? { test: true as const } : {}), kind: 'live', exp, createdAt: now };
  await ctx.kv.set(dataKey(hash), JSON.stringify(full), keyTtl(exp, now));
  await ctx.kv.indexAdd(idxKey(rec.userId), hash, LIVE_CAP_S);
  await ctx.kv.set(liveViewKey(hash), rec.channelId, VIEW_TTL_S);
  const me = { hash, rec: full };
  for (const t of await listTokens(ctx, rec.userId)) {
    if (t.hash !== hash && t.rec.deviceId === rec.deviceId && Boolean(t.rec.test) === Boolean(full.test) && viaClass(t.rec.via) === viaClass(full.via) && older(t, me) < 0) await revokeLiveToken(ctx, t.hash);
  }
  const all = (await listTokens(ctx, rec.userId)).sort(older);
  while (all.length > MAX_LIVE_TOKENS) await revokeLiveToken(ctx, all.shift()!.hash);
  return { token, hash, expiresAt: exp };
}

/** Revokes one token: the marker first (a concurrent authz answers 410), then its keys and its live record. */
export async function revokeLiveToken(ctx: Ctx, hash: string): Promise<void> {
  await ctx.kv.set(goneKey(hash), '1', LIVE_GONE_TTL_S);
  const rec = await load(ctx, hash);
  for (const k of [dataKey(hash), pinKey(hash), pin2Key(hash), liveViewKey(hash)]) await ctx.kv.del(k);
  rightsMemo.delete(hash);
  if (rec) {
    await ctx.kv.indexRemove(idxKey(rec.userId), hash);
    await clearLive(ctx, rec.userId, livePlaySessionId(hash));
  }
}

/**
 * `DELETE /api/livetv/watch` (spec §7.2): the caller ends its own token. Another account's token, an unknown or malformed one: nothing
 * happens (the route answers the same either way).
 */
export async function endLiveToken(ctx: Ctx, token: string, userId: string): Promise<void> {
  if (!CAST_TOKEN_RE.test(token)) return;
  const hash = hashToken(token);
  const rec = await load(ctx, hash);
  if (rec && rec.userId === userId) await revokeLiveToken(ctx, hash);
}

/**
 * The live records (play sessions) of a device's live tokens that its next watch of `via` replaces (mintLiveToken revokes them): the
 * watch route leaves them out of the `maxStreams` count (spec §7.2). Admin test previews and the other slot (cast or local, R14) are
 * not replaced by that watch, so they are not among them.
 */
export async function deviceLiveSessions(ctx: Ctx, userId: string, deviceId: string, via: LiveTokenRec['via'] = 'local'): Promise<string[]> {
  return (await listTokens(ctx, userId)).filter((t) => t.rec.deviceId === deviceId && !t.rec.test && viaClass(t.rec.via) === viaClass(via)).map((t) => livePlaySessionId(t.hash));
}

/**
 * The live records (play sessions) of the account's minted but never fetched live tokens (no gateway authz yet, so no `play:` record
 * exists): the watch route counts them toward `maxStreams` too (review L1), else minting several tokens first and fetching them
 * afterwards would get past the limit. Admin test previews are left out, as before their first fetch.
 */
export async function unfetchedLiveSessions(ctx: Ctx, userId: string): Promise<string[]> {
  return (await listTokens(ctx, userId)).filter((t) => !t.rec.test && t.rec.seen === undefined).map((t) => livePlaySessionId(t.hash));
}

/**
 * The account's running streams for the `maxStreams` limit of VOD and cast playback: the `play:` records plus live tokens minted but
 * not fetched yet (L1 rest, as the live watch route counts them), each session once.
 */
export async function countStreams(ctx: Ctx, userId: string): Promise<number> {
  const prefix = `play:${userId}:`;
  const running = new Set((await ctx.kv.keys(prefix)).map((k) => k.slice(prefix.length)));
  for (const ps of await unfetchedLiveSessions(ctx, userId)) running.add(ps);
  return running.size;
}

/**
 * The device's current live view (ruling 36): its newest normal `local` token (local or AirPlay), which the device's next local watch
 * replaces (mintLiveToken). A watch for another channel from this device is a channel switch (Task 32). Admin test previews are not
 * views a watch replaces (R8), and neither is a cast (R14): a Chromecast token is a viewer of its channel, never the device's own view.
 */
export async function deviceLiveView(ctx: Ctx, userId: string, deviceId: string): Promise<{ hash: string; channelId: string } | null> {
  const mine = (await listTokens(ctx, userId)).filter((t) => t.rec.deviceId === deviceId && !t.rec.test && viaClass(t.rec.via) === 'local').sort(older);
  const t = mine[mine.length - 1];
  return t ? { hash: t.hash, channelId: t.rec.channelId } : null;
}

/** how long an admin's *Stoppen* keeps the channel from starting again (the viewers' players meet the error state meanwhile, spec §7.4) */
export const ADMIN_STOP_TTL_S = 60;
/** the marker of an admin stop (`ltv:adminstop:<channelId>`): startOrJoin refuses the channel while it lives; *Neu starten* clears it */
export const adminStopKey = (channelId: string) => `ltv:adminstop:${channelId}`;

/** Revokes every live token on one channel (all accounts, admin test previews included): an admin stopped it. Returns the count. */
export async function revokeChannelTokens(ctx: Ctx, channelId: string): Promise<number> {
  let n = 0;
  for (const idx of await ctx.kv.keys(idxKey(''))) {
    for (const t of await listTokens(ctx, idx.slice(idxKey('').length))) {
      if (t.rec.channelId !== channelId) continue;
      await revokeLiveToken(ctx, t.hash);
      n++;
    }
  }
  return n;
}

/**
 * Revokes the account's tokens, or only those minted on one device; `exceptDevice` spares one device. Called next to revokeCasts
 * (sign-out / revokeSessions, device removal, account lock, profile switch, logout). Returns the count.
 */
export async function revokeLiveTokens(ctx: Ctx, userId: string, deviceId?: string, exceptDevice?: string): Promise<number> {
  let n = 0;
  for (const t of await listTokens(ctx, userId)) {
    if (deviceId && t.rec.deviceId !== deviceId) continue;
    if (exceptDevice && t.rec.deviceId === exceptDevice) continue;
    await revokeLiveToken(ctx, t.hash);
    n++;
  }
  return n;
}

/**
 * The player's heartbeat (every 20 s while open, playing or paused): slides the token's TTL and keeps its viewer key and live record.
 * A `local` token re-pins to `ip` when the beat comes from the session that minted it (Review Focus 4); a beat of any other session
 * only slides. Unknown, expired, revoked, another account's or a token whose rights are refused (same 2 s memo as authz) -> 410.
 */
export async function beatLiveToken(ctx: Ctx, token: string, who: { userId: string; sidHash: string; ip: string }): Promise<{ ok: true; expiresAt: number } | { ok: false; status: 410 }> {
  const gone = { ok: false, status: 410 } as const;
  if (!CAST_TOKEN_RE.test(token)) return gone;
  const hash = hashToken(token);
  if (await ctx.kv.get(goneKey(hash))) return gone;
  const rec = await load(ctx, hash);
  const now = Date.now();
  if (!rec || rec.exp <= now || rec.userId !== who.userId) return gone;
  const ttl = keyTtl(rec.exp, now);
  if (!(await rightsOf(ctx, hash, rec))) return gone; // a refused token is no viewer: nothing slides, re-pins or refreshes
  if (ttl <= 0 || !(await ctx.kv.replace(dataKey(hash), JSON.stringify(rec), ttl))) return gone; // never resurrects a revoked one
  if (rec.via === 'local' && rec.sidHash === who.sidHash) {
    await ctx.kv.set(pinKey(hash), who.ip, pinTtl(rec.exp, now));
    await ctx.kv.del(pin2Key(hash));
  }
  await ctx.kv.set(liveViewKey(hash), rec.channelId, VIEW_TTL_S);
  const ps = livePlaySessionId(hash);
  const cur = await getLive(ctx, rec.userId, ps);
  if (cur) await setLive(ctx, { ...cur, updatedAt: now });
  if (await ctx.kv.get(goneKey(hash))) await forgetView(ctx, hash, rec.userId); // revoked meanwhile: nothing it wrote stays
  return { ok: true, expiresAt: rec.exp };
}

const forgetView = async (ctx: Ctx, hash: string, userId: string) => {
  await ctx.kv.del(liveViewKey(hash));
  await clearLive(ctx, userId, livePlaySessionId(hash));
};

/** F10: the channel exists in an enabled source and is not missing (hidden and unreleased channels pass: that is what a test is for) */
async function channelPresent(ctx: Ctx, channelId: string): Promise<boolean> {
  const r = await ctx.db.query(
    `select 1 from livetv_channels c join livetv_sources s on s.id = c.source_id
      where c.id::text = $1 and c.missing_since is null and s.enabled`, [channelId]);
  return r.rows.length > 0;
}

async function rightsOf(ctx: Ctx, hash: string, rec: StoredRec): Promise<{ userName: string; profileName: string } | null> {
  const hit = rightsMemo.get(hash);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v: { userName: string; profileName: string } | null = null;
  const user = await getUserById(ctx, rec.userId);
  const role = user && !user.disabled ? await effectiveRole(ctx, user.role) : undefined;
  const prof = user && role ? await getProfile(ctx, user.id, rec.profileId) : null;
  const dev = prof ? await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [rec.userId, rec.deviceId]) : null;
  if (user && prof && dev?.rows[0]?.approved) {
    const ok = rec.test
      ? user.role === 'admin' && (await channelPresent(ctx, rec.channelId))
      : await channelAllowed(ctx, { id: user.id, role: user.role }, { id: prof.id, kids: prof.kids }, rec.channelId);
    if (ok) v = { userName: user.name, profileName: prof.name };
  }
  rightsMemo.set(hash, { exp: Date.now() + LIVE_RIGHTS_MEMO_MS, v });
  if (rightsMemo.size > 5000) rightsMemo.clear();
  return v;
}

/**
 * The gateway's authz of `/media/l/<token>/…` (`/internal/authz/live`): 401 unknown or expired, 410 revoked or the stream is gone,
 * 403 pinned elsewhere / account, profile or device no longer usable / right lost / channel hidden. The first resolve touches the
 * viewer key and writes the live record (ruling 21); later ones do at most every LIVE_TOUCH_MS (the mint's seeded viewer key does not
 * delay that first write).
 */
export async function resolveLiveToken(
  ctx: Ctx, token: string, ip: string, deps: { streamKeyFor(channelId: string): Promise<string | null>; bitrateFor?(channelId: string): Promise<number | null> },
): Promise<{ status: 200; streamKey: string; kind: 'live'; maxAgeS: number } | { status: 401 | 403 | 410 }> {
  if (!CAST_TOKEN_RE.test(token)) return { status: 401 };
  const hash = hashToken(token);
  if (await ctx.kv.get(goneKey(hash))) return { status: 410 };
  const rec = await load(ctx, hash);
  if (!rec || rec.exp <= Date.now()) return { status: 401 };
  const owner = await rightsOf(ctx, hash, rec);
  if (!owner) return { status: 403 };
  const streamKey = await deps.streamKeyFor(rec.channelId); // before the pin: a refused (410) request never takes one
  if (!streamKey) return { status: 410 };
  const airplay = rec.via === 'airplay';
  const slots = airplay && Date.now() - rec.createdAt <= AIRPLAY_PIN2_WINDOW_MS ? 2 : 1;
  if (!(await takePin(ctx, airplay ? [pinKey(hash), pin2Key(hash)] : [pinKey(hash)], ip, pinTtl(rec.exp), slots))) return { status: 403 };
  if (rec.seen === undefined || Date.now() - rec.seen >= LIVE_TOUCH_MS) await touch(ctx, hash, rec, owner, await deps.bitrateFor?.(rec.channelId).catch(() => null) ?? null);
  return { status: 200, streamKey, kind: 'live', maxAgeS: LIVE_AUTHZ_MAX_AGE_S };
}

/** sliding refresh + viewer key + live record (replace only: a token revoked in between is never resurrected) */
async function touch(ctx: Ctx, hash: string, rec: StoredRec, owner: { userName: string; profileName: string }, bitrate: number | null) {
  const now = Date.now();
  const ttl = keyTtl(rec.exp, now);
  if (ttl <= 0 || !(await ctx.kv.replace(dataKey(hash), JSON.stringify({ ...rec, seen: now } satisfies StoredRec), ttl))) return;
  await ctx.kv.set(liveViewKey(hash), rec.channelId, VIEW_TTL_S);
  const ps = livePlaySessionId(hash);
  const cur = await getLive(ctx, rec.userId, ps);
  await setLive(ctx, cur
    ? { ...cur, updatedAt: now, ...(bitrate !== null ? { bitrate } : {}) }
    : {
      userId: rec.userId, userName: owner.userName, profileName: owner.profileName, itemId: `ch:${rec.channelId}`, title: rec.channelName,
      positionTicks: 0, isPaused: false, playSessionId: ps, updatedAt: now, source: 'livetv', deviceId: rec.deviceId, remote: rec.remote,
      ...(bitrate !== null ? { bitrate } : {}),
    });
  if (await ctx.kv.get(goneKey(hash))) await forgetView(ctx, hash, rec.userId);
}

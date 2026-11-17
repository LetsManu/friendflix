// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The per-role stream limit (`maxStreams`) where streams are really served (security audit G1). The client's own playback reports
 * (`play:` records) are no longer the only source: the gateway asks `/internal/stream` before it serves a playlist, segment or stream of
 * a play session, and the backend keeps a `serve:<user>:<key>` record per served stream that lives SERVE_TTL_S after its last request.
 *
 * What counts as one stream: a play session (`play:` or `serve:`, the same play session once) or a live token minted but not fetched yet.
 * Sessions of the same device and the same item are ONE stream (seeking, a new play session for a quality or audio switch, a resume).
 * A running stream whose stop was reported may fetch its last segments for DRAIN_S, but only while they fit next to every other
 * stream, and while it is served it counts for every new start, except that a new start of the same device spares one draining stream
 * of that device (the next episode after the stop). Only a stop of a stream that was running opens that window, and only once (a stop
 * report for anything else, or a second one, does not), so stop reports are no way to stream uncounted. /api/playback/info counts the same set, so a
 * stream whose info was granted (the next episode prepared during the autoplay countdown included) also fits when it is first served,
 * unless another stream started meanwhile.
 *
 * Claims run one at a time per account (an in-process queue: a single backend replica, docs/security.md), so two new streams can
 * never both take the last slot.
 */
import { createHash } from 'node:crypto';
import type { Ctx } from './ctx.js';
import { unfetchedCastSessions } from './cast.js';
import { effectiveLimits } from './limits.js';
import { sessionHash } from './session.js';
import { unfetchedLiveSessions } from './livetv/tokens.js';
import type { UserRow } from './types.js';

/** a served stream is forgotten this long after its last request (a paused player keeps its slot through its progress reports) */
export const SERVE_TTL_S = 60;

/** after a running stream's stop: how long its trailing requests may be served without a counted record of their own */
export const DRAIN_S = 120;
/** a draining stream counts while it was served this recently (the gateway re-asks every 10 s while it serves it) */
export const DRAIN_SEEN_S = 20;

/**
 * `serve:<user>:<key>`: key = `<play session>~<stream>` (or `item-<itemId>~<stream>` for a request that names none), where `<stream>`
 * is a short hash of the device and the title. The play session id comes from the client's URL, so it never names a stream by itself
 * (review B): the same id from another device or for another title is another record, and counts as another stream.
 */
export const serveKey = (userId: string, key: string) => `serve:${userId}:${key}`;
const drainKey = (userId: string, key: string) => `servedrain:${userId}:${key}`;
interface ServeRec { deviceId: string; itemId: string; at: number }
/** the drain marker of a stopped stream: `until` = end of the window (never extended), `seen` = its last trailing request served */
interface DrainRec { deviceId?: string; itemId: string; until: number; seen?: number }
interface Session { deviceId?: string; itemId?: string; draining?: boolean }
/** what is never counted for a check: its own play sessions, and its own stream (same device and item) */
export interface StreamExcept { ps?: Iterable<string>; deviceId?: string; itemId?: string }

const PS = /^[\w-]{1,64}$/;
const streamTag = (deviceId: string, itemId: string) => createHash('sha256').update(`${deviceId}|${itemId.toLowerCase()}`).digest('hex').slice(0, 16);
/** the record key of a claim: the play session when it is a plain id (else the item), bound to the device and title */
export const claimKey = (deviceId: string, itemId: string, ps?: string | null) =>
  `${ps && PS.test(ps) ? ps : `item-${itemId.toLowerCase()}`}~${streamTag(deviceId, itemId)}`;
/** a reported stream (`play:` record) is this claim's own only for the same device and title */
export const sameStream = (l: { deviceId?: string; itemId?: string } | null, deviceId: string | undefined, itemId: string): boolean =>
  Boolean(l && deviceId && l.deviceId === deviceId && l.itemId?.toLowerCase() === itemId.toLowerCase());

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};

/** the account's running streams by play session: reported (`play:`), served (`serve:`), minted-but-unfetched live and cast tokens */
async function sessionsOf(ctx: Ctx, userId: string): Promise<Map<string, Session>> {
  const out = new Map<string, Session>();
  const playPrefix = `play:${userId}:`;
  for (const k of await ctx.kv.keys(playPrefix)) {
    const l = parse<{ deviceId?: string; itemId?: string }>(await ctx.kv.get(k));
    out.set(k.slice(playPrefix.length), { deviceId: l?.deviceId, itemId: l?.itemId });
  }
  const servePrefix = `serve:${userId}:`;
  for (const k of await ctx.kv.keys(servePrefix)) {
    const ps = k.slice(servePrefix.length);
    const r = parse<ServeRec>(await ctx.kv.get(k));
    if (!r) continue;
    const known = out.get(ps);
    // a reported stream keeps counting; the served record adds the device a report may not name
    out.set(ps, { deviceId: known?.deviceId ?? r.deviceId, itemId: known?.itemId ?? r.itemId });
  }
  for (const ps of await unfetchedLiveSessions(ctx, userId)) if (!out.has(ps)) out.set(ps, {});
  for (const ps of await unfetchedCastSessions(ctx, userId)) if (!out.has(ps)) out.set(ps, {});
  // a stopped stream that is still being served (its trailing requests) keeps counting (review: a drain must not be a free slot)
  const drainPrefix = `servedrain:${userId}:`;
  const now = Date.now();
  for (const k of await ctx.kv.keys(drainPrefix)) {
    const ps = k.slice(drainPrefix.length);
    const d = parse<DrainRec>(await ctx.kv.get(k));
    if (!d || out.has(ps) || !d.seen || now - d.seen > DRAIN_SEEN_S * 1000) continue;
    out.set(ps, { deviceId: d.deviceId, itemId: d.itemId, draining: true });
  }
  return out;
}

/** one stream per device and item; a session that names neither is a stream of its own */
const identity = (ps: string, s: Session) => (s.deviceId && s.itemId ? `d|${s.deviceId}|${s.itemId.toLowerCase()}` : `p|${ps}`);

/**
 * `spare`: a new start (not a stopped stream's trailing request) leaves out at most one draining stream of its own device, the one its
 * player just stopped (the next episode); every other draining stream that is still served counts.
 */
function countOf(sessions: Map<string, Session>, except: StreamExcept = {}, spare = true): number {
  const skipPs = new Set(except.ps ?? []);
  // a left-out play session also leaves out its served records (`<ps>~<stream>`): a report without a device (a session stored before
  // device ids) must not meet its own stream again under the gateway's fallback device
  const skipped = (ps: string) => skipPs.has(ps) || (ps.includes('~') && skipPs.has(ps.slice(0, ps.indexOf('~'))));
  const mine = except.deviceId && except.itemId ? identity('', { deviceId: except.deviceId, itemId: except.itemId }) : null;
  const ids = new Set<string>();
  let spared: string | null = null;
  for (const [ps, s] of sessions) {
    if (skipped(ps)) continue;
    const id = identity(ps, s);
    if (id === mine) continue;
    if (spare && s.draining && except.deviceId && s.deviceId === except.deviceId && (spared === null || spared === id)) { spared = id; continue; }
    ids.add(id);
  }
  return ids.size;
}

/**
 * The account's running streams for a new playback (VOD info and start report, cast, Live TV and recordings): reported, served and
 * minted-but-unfetched ones, without `except` (the caller's own play sessions and its own device + item).
 */
export async function countStreams(ctx: Ctx, userId: string, except: StreamExcept = {}): Promise<number> {
  return countOf(await sessionsOf(ctx, userId), except);
}

const queues = new Map<string, Promise<unknown>>();
/** runs `fn` after every earlier one of this account (claims and stream starts), in this process */
export function streamSerial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(userId, tail);
  void tail.then(() => { if (queues.get(userId) === tail) queues.delete(userId); });
  return run;
}

/**
 * A stream's stop was reported: its served records go at once (the play session's, and any other of the same device and item, e.g.
 * requests that named no play session). `running`: the caller knew the stream as running (its live record existed). Only a stream that
 * was running or served opens the DRAIN_S window for its trailing requests; a stop of anything else opens nothing.
 */
export async function forgetServed(ctx: Pick<Ctx, 'kv'>, userId: string, s: { ps: string; deviceId?: string; itemId: string; running: boolean }): Promise<void> {
  // only the stopping device's streams of this title (served records are bound to device and title): a stop never ends another's.
  // A session without a device id (stored before them) passes the same fallback device the gateway's claims use (streamDeviceOf).
  if (!s.deviceId) return;
  const prefix = `serve:${userId}:`;
  const item = s.itemId.toLowerCase();
  const gone: string[] = [];
  for (const k of await ctx.kv.keys(prefix)) {
    const key = k.slice(prefix.length);
    const r = parse<ServeRec>(await ctx.kv.get(k));
    if (!r || r.deviceId !== s.deviceId || r.itemId !== item) continue;
    gone.push(key);
    await ctx.kv.del(k);
  }
  if (!s.running && !gone.length) return;
  const rec: DrainRec = { deviceId: s.deviceId, itemId: item, until: Date.now() + DRAIN_S * 1000 };
  const keys = [claimKey(s.deviceId, item, s.ps), claimKey(s.deviceId, item, null), ...gone];
  for (const key of new Set(keys)) await ctx.kv.set(drainKey(userId, key), JSON.stringify(rec), DRAIN_S);
}

/** the device a session's streams are counted under: its device id, else (a session stored before device ids) one derived from it */
export const streamDeviceOf = (deviceId: string | undefined, sid: string): string => deviceId ?? `sid-${sessionHash(sid).slice(0, 16)}`;

export type ClaimResult = { ok: true } | { error: 'max_streams'; max: number };

/**
 * The gateway is about to serve a request of a stream: `ok` keeps (or starts) the stream's served record; `max_streams` = a new stream
 * beyond the account's limit (the gateway answers 429 with the same body as /api/playback/info).
 */
export function claimStream(ctx: Ctx, user: UserRow, a: { deviceId: string; itemId: string; ps?: string | null }): Promise<ClaimResult> {
  return streamSerial(user.id, async () => {
    const itemId = a.itemId.toLowerCase();
    const key = claimKey(a.deviceId, itemId, a.ps);
    const rk = serveKey(user.id, key);
    const own = parse<ServeRec>(await ctx.kv.get(rk));
    const keep = async () => {
      await ctx.kv.set(rk, JSON.stringify({ deviceId: a.deviceId, itemId, at: own?.at ?? Date.now() } satisfies ServeRec), SERVE_TTL_S);
      return { ok: true } as const;
    };
    // a reported stream (it passed the limit when it started) or one already counted: served on (seeking, the next segments)
    // (the record key carries device and title; a reported stream only counts as this one for the same device and title)
    const ps = a.ps && PS.test(a.ps) ? a.ps : null;
    if (own || (ps && sameStream(parse<{ deviceId?: string; itemId?: string }>(await ctx.kv.get(`play:${user.id}:${ps}`)), a.deviceId, itemId))) return keep();
    const max = (await effectiveLimits(ctx, user))!.maxStreams;
    const sessions = await sessionsOf(ctx, user.id);
    const others = { ps: [key], deviceId: a.deviceId, itemId };
    // a running stream's stop was reported a moment ago: the player may still fetch what it buffered, but only while it fits next to
    // everything else (no draining stream is spared for it); it then counts for the others as long as it is served
    const drain = parse<DrainRec>(await ctx.kv.get(drainKey(user.id, key)));
    if (drain) {
      if (countOf(sessions, others, false) >= max) return { error: 'max_streams', max };
      const ttl = Math.ceil((drain.until - Date.now()) / 1000);
      if (ttl > 0) await ctx.kv.set(drainKey(user.id, key), JSON.stringify({ ...drain, seen: Date.now() } satisfies DrainRec), ttl);
      return { ok: true };
    }
    if (countOf(sessions, others) >= max) return { error: 'max_streams', max };
    return keep();
  });
}

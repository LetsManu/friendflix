// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fake deps of the cast engine (lib/cast/engine.ts): every api call recorded, a writable castState, manual timers, an
// in-memory localStorage, the token lookup (GET /api/cast/session/:castId) and no DOM. Shared by engine.test.ts and
// engine.resume.test.ts.
// Test infrastructure only: excluded from coverage (see vitest.config.ts).
import { writable } from 'svelte/store';
import { vi } from 'vitest';
import { ApiError, secToTicks, type Item } from '#lib/api';
import type { CastEvent, CastInfo, CastState } from '#lib/cast';
import type { CastLogEntry } from '#lib/cast/castLog';
import { createCastEngine, type CastSession, type EngineDeps, type PlayerHandoff } from '#lib/cast/engine';
import { readHint, sha256Hex, type CastHint, type CastLookup, type Store } from '#lib/cast/resume';
import { DEFAULT_PREFS, type Prefs } from '#lib/stores';

export const T0 = 1_000_000;
export const ci = (castId: string, over: Partial<CastInfo> = {}): CastInfo => ({
  castId, expiresAt: T0 + 60 * 60_000, playSessionId: `ps-${castId}`, mediaSourceId: `ms-${castId}`, runtimeTicks: secToTicks(1800), startTime: 0,
  contentUrl: `/media/c/${castId}/master.m3u8`, contentType: 'application/x-mpegURL', hlsSegmentFormat: 'ts', title: 'T', subtitles: [], ...over,
});
export const items: Record<string, Partial<Item>> = {
  ep2: { id: 'ep2', name: 'Second', type: 'Episode', seriesId: 's1', seriesName: 'Bright Valley', indexNumber: 2, parentIndexNumber: 1 },
  ep3: { id: 'ep3', name: 'Third', type: 'Episode', seriesId: 's1', seriesName: 'Bright Valley', indexNumber: 3, parentIndexNumber: 1 },
  /** a special without season / episode numbers */
  sp1: { id: 'sp1', name: 'Christmas Special', type: 'Episode', seriesId: 's1', seriesName: 'Bright Valley' },
  film: { id: 'film', name: 'Film', type: 'Movie' },
  other: { id: 'other', name: 'Other', type: 'Movie' },
  /** fictional titles of the resume tests */
  dun4: { id: 'dun4', name: 'The Lantern Road', type: 'Episode', seriesId: 'dun', seriesName: 'Dunmoor', indexNumber: 4, parentIndexNumber: 1 },
  dun5: { id: 'dun5', name: 'Wrenfield Pier', type: 'Episode', seriesId: 'dun', seriesName: 'Dunmoor', indexNumber: 5, parentIndexNumber: 1 },
};
/** GET /api/items/{id}/next: the episode after ep1 is ep2 (others: none) */
export const nexts: Record<string, string> = { ep1: 'ep2', ep2: 'ep3', ep5: 'sp1', dun4: 'dun5' };
export const idle: CastState = { available: true, connected: true, deviceName: 'Wohnzimmer-TV', state: 'idle', currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, loaded: false, contentId: '', idleReason: null, castId: '', queue: [] };
export const playing = (over: Partial<CastState> = {}): CastState => ({ ...idle, state: 'playing', loaded: true, paused: false, currentTime: 60, duration: 1800, ...over });

export function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** also waits for real async work (crypto.subtle's digest is not a microtask) */
export const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); await flush(); } };

/** an in-memory localStorage */
export const memStore = (): NonNullable<Store> & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); } };
};
/** a 32-hex castId (the hint keeps only well-formed handles): `hex('c1')` = 'c1000…' */
export const hex = (s: string) => s.padEnd(32, '0');
/** a 43-char base64url token and the content URL the receiver reports for it */
export const token = (s: string) => s.padEnd(43, 'x');
export const contentOf = (tok: string) => `https://friend.example.com/media/c/${tok}/master.m3u8`;
/** the backend's castId of a token (first 32 hex of its sha256) */
export const castIdOf = async (tok: string) => (await sha256Hex(tok)).slice(0, 32);
/** a lookup answer for a token of this account / profile / device */
export const lookup = (castId: string, itemId: string, over: Partial<CastLookup> = {}): CastLookup => ({
  castId, itemId, mediaSourceId: `ms-${itemId}`, playSessionId: `ps-${itemId}`, expiresAt: T0 + 2 * 60 * 60_000, runtimeTicks: secToTicks(3000),
  via: 'chromecast', next: false, reported: true, title: 'The Lantern Road', seriesName: 'Dunmoor',
  subtitles: [{ index: 3, language: 'de', title: 'Deutsch' }], pins: 1, refused: { count: 0, families: [] }, ...over,
});

/**
 * navigator.locks for the one-owner-per-browser lock: `ifAvailable` answers null while another engine holds it; without it the
 * request waits and is granted when the holder releases. Share one between two setups to model two tabs.
 */
export function fakeLock() {
  let held = false;
  const waiters: Array<(r: () => void) => void> = [];
  const grant = (): (() => void) => {
    held = true;
    let done = false;
    return () => {
      if (done) return;
      done = true; held = false;
      const w = waiters.shift();
      if (w) w(grant());
    };
  };
  return {
    acquire: vi.fn(async (ifAvailable: boolean): Promise<(() => void) | null> => {
      if (!held) return grant();
      if (ifAvailable) return null;
      return new Promise<() => void>((r) => waiters.push(r));
    }),
    held: () => held,
    waiting: () => waiters.length,
  };
}
export type FakeLock = ReturnType<typeof fakeLock>;

type Init = { method?: string; body?: any; keepalive?: boolean };
export function setup(o: { prefs?: Partial<Prefs>; lock?: FakeLock } = {}) {
  const calls: Array<{ path: string; init: Init }> = [];
  const order: string[] = [];
  let n = 0, qn = 0;
  /** answers of POST /api/cast/session (default: a fresh token c<n>) */
  const posts: Array<() => Promise<CastInfo>> = [];
  /** answers of POST /api/cast/session with `next: true` (default: a queue token q<n>) */
  const queuePostAnswers: Array<() => Promise<CastInfo>> = [];
  /** GET /api/cast/session/:castId (absent: 404) */
  const lookups: Record<string, CastLookup> = {};
  const api = vi.fn(async (path: string, init: Init = {}) => {
    calls.push({ path, init });
    order.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/cast/session' && init.body?.next) { const next = queuePostAnswers.shift(); return next ? next() : ci(`q${++qn}`); } // the receiver queue's token (own ids)
    if (path === '/api/cast/session') { const next = posts.shift(); return next ? next() : ci(`n${++n}`); }
    const lk = /^\/api\/cast\/session\/([^/]+)$/.exec(path);
    if (lk && (init.method ?? 'GET') === 'GET') { const l = lookups[lk[1]!]; if (!l) throw new ApiError(404, { error: 'not_found' }); return l; }
    const nx = /^\/api\/items\/([^/]+)\/next$/.exec(path);
    if (nx) return { item: nexts[nx[1]!] ? items[nexts[nx[1]!]!] : null };
    return null;
  });
  const state = writable<CastState>({ ...idle });
  let subs = 0;
  const castState = { ...state, subscribe: (fn: (s: CastState) => void) => { subs++; const un = state.subscribe(fn); return () => { subs--; un(); }; } };
  const events = new Set<(e: CastEvent) => void>();
  const loads: Array<{ info: CastInfo; sub: number }> = [];
  let loadImpl: (info: CastInfo) => Promise<boolean> = async () => true;
  /** the receiver's queue: refused (null) unless a test accepts it */
  const queued: CastInfo[] = [];
  let queueImpl: (info: CastInfo) => number | null = () => null;
  const cast = {
    castState,
    onCastEvent: vi.fn((fn: (e: CastEvent) => void) => { events.add(fn); return () => { events.delete(fn); }; }),
    loadOnCast: vi.fn(async (info: CastInfo, sub = -1) => { loads.push({ info, sub }); return loadImpl(info); }),
    castPlayPause: vi.fn(), castSeek: vi.fn(), castStop: vi.fn(), castSetSubtitle: vi.fn(),
    queueOnCast: vi.fn(async (info: CastInfo): Promise<number | null> => { queued.push(info); return queueImpl(info); }), castQueueRemove: vi.fn(), castQueueNext: vi.fn(),
    castAdoptTracks: vi.fn(), castLeave: vi.fn(),
  };
  let now = T0;
  let timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let tid = 0;
  const timerDeps = {
    set: vi.fn((fn: () => void, ms: number) => { const t = { fn, at: now + ms, id: ++tid }; timers.push(t); return t.id; }),
    clear: vi.fn((id: unknown) => { timers = timers.filter((t) => t.id !== id); }),
    now: () => now,
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = end;
  };
  const hides = new Set<() => void>();
  const wakes = new Set<() => void>();
  const hiddens = new Set<() => void>();
  const readies: Array<() => void> = [];
  const restores = new Set<() => void>();
  const lock = o.lock ?? fakeLock();
  /** the title's segments (GET /api/items/{id}/segments as the engine gets them) */
  const segs: Record<string, Array<{ type: string; start: number; end: number }>> = {};
  let hiddenNow = false;
  const toast = vi.fn();
  const item = vi.fn(async (id: string) => { const it = items[id]; if (!it) throw new Error('404'); return it as Item; });
  const store = memStore();
  const logs: Array<Omit<CastLogEntry, 'at'>> = [];
  let requestImpl: () => Promise<boolean> = async () => true;
  const deps: EngineDeps = {
    api: api as unknown as EngineDeps['api'], item, cast: cast as unknown as EngineDeps['cast'], air: vi.fn() as unknown as EngineDeps['air'],
    body: () => ({}) as HTMLElement,
    onPageHide: vi.fn((fn: () => void) => { hides.add(fn); return () => { hides.delete(fn); }; }),
    segments: vi.fn(async (id: string) => segs[id] ?? []), hidden: () => hiddenNow,
    onWake: vi.fn((fn: () => void) => { wakes.add(fn); return () => { wakes.delete(fn); }; }),
    onHidden: vi.fn((fn: () => void) => { hiddens.add(fn); return () => { hiddens.delete(fn); }; }),
    toast, prefs: () => ({ ...DEFAULT_PREFS, ...o.prefs }), timers: timerDeps,
    store, digest: sha256Hex, log: (e) => { logs.push(e); },
    requestSession: vi.fn(() => requestImpl()), leave: vi.fn(), whenReady: vi.fn((fn: () => void) => { readies.push(fn); }),
    lock: lock.acquire,
    onRestore: vi.fn((fn: () => void) => { restores.add(fn); }),
  };
  const out = writable<CastSession | null>(null);
  const engine = createCastEngine(deps, out);
  return {
    engine, out, deps, calls, order, posts, queuePostAnswers, lookups, api, state, cast, events, loads, toast, timers: timerDeps, hides, item, store, logs, lock,
    /** the page came back from the back/forward cache */
    restore: () => restores.forEach((fn) => fn()),
    advance, segs, wakes, hide: (on: boolean) => { hiddenNow = on; }, wake: () => wakes.forEach((fn) => fn()), subs: () => subs, pending: () => timers.length,
    setLoad: (f: (info: CastInfo) => Promise<boolean>) => { loadImpl = f; },
    setQueue: (f: (info: CastInfo) => number | null) => { queueImpl = f; }, queued,
    setRequest: (f: () => Promise<boolean>) => { requestImpl = f; },
    /** the Cast SDK finished its setup (whenReady callbacks run) */
    ready: () => readies.forEach((fn) => fn()),
    pagehide: () => hides.forEach((fn) => fn()),
    emit: (e: CastEvent) => events.forEach((fn) => fn(e)),
    hint: (): CastHint | null => readHint(store, now),
    now: () => now,
    reports: () => calls.filter((c) => c.path.startsWith('/api/playback/')).map((c) => c.path.slice('/api/playback/'.length)),
    deletes: () => calls.filter((c) => c.init.method === 'DELETE').map((c) => c.path.slice('/api/cast/session/'.length)),
    tokenPosts: () => calls.filter((c) => c.path === '/api/cast/session' && !c.init.body?.next),
    queuePosts: () => calls.filter((c) => c.path === '/api/cast/session' && c.init.body?.next),
    lookupsAsked: () => calls.filter((c) => /^\/api\/cast\/session\/[^/]+$/.test(c.path) && (c.init.method ?? 'GET') === 'GET').map((c) => c.path.slice('/api/cast/session/'.length)),
    lastReport: () => calls.filter((c) => c.path.startsWith('/api/playback/')).at(-1),
  };
}
export type Env = ReturnType<typeof setup>;

export const handoff = (over: Partial<PlayerHandoff> = {}): PlayerHandoff => ({
  kind: 'chromecast', itemId: 'film', title: 'Film', subtitle: '', isEpisode: false, position: 60, duration: 1800, paused: false,
  cast: ci('c1'), started: false, audioIndex: 1, subIndex: -1, maxBitrate: 8_000_000, sleepAfterEpisode: false, ...over,
});
/** adopted Chromecast session that already reported `start` */
export async function playingSession(env: Env, over: Partial<PlayerHandoff> = {}) {
  env.state.set(playing());
  env.engine.adopt(handoff({ started: true, ...over }));
  await flush();
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetConvMemo, admitConversion } from '../src/convbudget.js';
import { preparer, type FfmpegRunner } from '../src/downloadprep.js';
import { previews } from '../src/previews.js';
import { fragment, initSegment } from './fmp4build.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

// Live TV Phase 1, Task 3: download preparation waits for a conversion slot (spec §5.2, ruling 10). A refusal, or an unreadable
// session list, keeps the job queued for the next tick; it never fails it.

const PS = 'ps-dl-budget1';
const INIT = initSegment();
const SEGS = 6;
type RawSession = Record<string, unknown>;
const converting = (ps: string): RawSession => ({
  Id: `s-${ps}`, UserId: 'jf-u1', DeviceId: `dev-${ps}`, Client: 'Other app', DeviceName: 'Wohnzimmer',
  NowPlayingItem: { Id: 'a'.repeat(32), Name: 'Dunmoor', Type: 'Movie' },
  PlayState: { PlayMethod: 'Transcode', PlaySessionId: ps, IsPaused: false },
  TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: false, VideoCodec: 'h264' },
});

let env: TestEnv;
let dir: string;
let raw: RawSession[] = [];
let onSeg: (n: number) => void = () => undefined;
let failInfo = false;
/** every PlaybackInfo opens a new play session when set (a restarted pass gets its own) */
let psCount = 0;
let freshPs = false;
let transcode = 0;
let restartGap = 0;
const runner: FfmpegRunner = { remux: async (input, output) => { await copyFile(input, output); } };
const origSessions = () => origSessionsFn;
let origSessionsFn: typeof env.ctx.jf.admin.transcodeSessions;

async function job(over: { quality?: string } = {}) {
  const id = randomUUID();
  await env.pool.query("insert into download_jobs(id,item_id,quality,audio_lang,status,max_height,max_bitrate) values ($1,$2,$3,'','queued',0,0)", [id, randomUUID().replace(/-/g, ''), over.quality ?? 'hd']);
  const user = (await env.pool.query('select id from users limit 1')).rows[0].id;
  const prof = (await env.pool.query('select id from profiles where user_id = $1 limit 1', [user])).rows[0].id;
  const dev = (await env.pool.query('select device_id from devices where user_id = $1 limit 1', [user])).rows[0].device_id;
  await env.pool.query(
    "insert into downloads(id,user_id,device_id,profile_id,item_id,job_id,quality,status,expires_at,meta) values ($1,$2,$3,$4,$5,$6,'hd','pending', now() + interval '30 days', $7)",
    [randomUUID(), user, dev, prof, randomUUID().replace(/-/g, ''), id, JSON.stringify({ runtimeTicks: 90 * 600_000_000 })],
  );
  return id;
}
const status = async (id: string) => (await env.pool.query('select status, error from download_jobs where id = $1', [id])).rows[0] as { status: string; error: string | null };
const grants = async () => env.kv.keys('conv:grant:');
const ask = (kind: 'film' | 'download' = 'film') => admitConversion(env.ctx, { kind, userId: randomUUID(), hint: randomUUID() });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-dlb-'));
  env = await makeEnv({
    'GET /Sessions': () => ({ json: raw }),
    'GET /Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'Der Film', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'Der Film', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'POST /Items/[^/]+/PlaybackInfo': () => failInfo ? { status: 500, raw: 'boom' } : ({
      json: {
        PlaySessionId: freshPs ? `ps-seam-${++psCount}` : PS,
        MediaSources: [{
          Id: 'ms1', Container: 'mkv', Bitrate: 9_000_000, Size: 7_000_000_000, RunTimeTicks: 90 * 600_000_000,
          MediaStreams: [{ Type: 'Video', Index: 0, Codec: 'h264', Height: 1080 }, { Type: 'Audio', Index: 1, Codec: 'ac3', Language: 'eng', IsDefault: true }],
        }],
      },
    }),
    'GET /Videos/[^/]+/master.m3u8': () => ({ raw: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?PlaySessionId=${PS}\n` }),
    'GET /Videos/[^/]+/main.m3u8': () => ({ raw: `#EXTM3U\n#EXT-X-MAP:URI="hls1/main/-1.mp4"\n${Array.from({ length: SEGS }, (_, n) => `#EXTINF:6.0,\nhls1/main/${n}.mp4`).join('\n')}\n#EXT-X-ENDLIST\n` }),
    'GET /Videos/[^/]+/hls1/main/[^/]+': (u) => {
      const n = parseInt(u.pathname.split('/').pop()!, 10);
      if (n >= 0) onSeg(n);
      return { raw: n < 0 ? INIT : fragment(n, { restartGapSec: transcode * restartGap }) };
    },
    'DELETE /Videos/ActiveEncodings': () => { transcode++; return { status: 204 }; },
  }, { ctxPatch: (c) => { c.cfg = { ...c.cfg, DOWNLOAD_DIR: dir }; } });
  await env.login();
  origSessionsFn = env.ctx.jf.admin.transcodeSessions;
  const p = preparer(env.ctx);
  p.runner = runner;
  p.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  p.pollMs = 5;
});
afterAll(() => env.close());
beforeEach(async () => {
  env.ctx.cfg = { ...env.ctx.cfg, ...cfg, DOWNLOAD_DIR: dir, CONVERSION_PRIORITY: 'films', CONVERSION_SLOTS: undefined };
  __resetConvMemo();
  raw = [];
  onSeg = () => undefined;
  failInfo = false; freshPs = false; psCount = 0; transcode = 0; restartGap = 0;
  for (const k of await env.kv.keys('conv:')) await env.kv.del(k);
  await env.pool.query('delete from downloads'); await env.pool.query('delete from download_jobs');
});
afterEach(() => { env.ctx.jf.admin.transcodeSessions = origSessions(); });

describe('download preparation and the conversion budget', () => {
  it('a queued download waits while the budget is full and starts when it frees', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, CONVERSION_SLOTS: 2, CONVERSION_PRIORITY: 'films' };
    raw = [converting('ps-film-1')];
    const id = await job();
    const p = preparer(env.ctx);
    const logs: string[] = [];
    const log = p.log;
    p.log = (m) => logs.push(m);
    try {
      await p.tick(); await p.whenIdle();
      expect(await status(id)).toMatchObject({ status: 'queued', error: null });
      await p.tick(); await p.whenIdle(); // still full: no second line
      expect(await status(id)).toMatchObject({ status: 'queued' });
      expect(logs.filter((l) => l.includes(`download ${id} waits for a conversion slot`))).toHaveLength(1);
      expect(logs.join('\n')).not.toMatch(/ps-film-1|http|token/i);

      raw = [];
      let seen = '';
      onSeg = (n) => { if (n === 0) void status(id).then((s) => { seen = s.status; }); };
      await p.tick(); await p.whenIdle();
      expect(seen).toBe('preparing');
      expect(await status(id)).toMatchObject({ status: 'ready' });
    } finally { p.log = log; }
  });

  it('single slot: a download runs once nothing converts', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, CONVERSION_SLOTS: 1 };
    const id = await job();
    let film: Awaited<ReturnType<typeof ask>> | undefined;
    let stillPreparing = '';
    onSeg = (n) => {
      if (n !== 1) return;
      raw = [converting(PS)]; // the media server now lists the download's own session
      void ask('film').then((r) => { film = r; });
      void status(id).then((s) => { stillPreparing = s.status; });
    };
    const p = preparer(env.ctx);
    await p.tick(); await p.whenIdle();
    expect(film).toEqual({ ok: false, why: 'full' });
    expect(stillPreparing).toBe('preparing'); // never stopped
    expect(await status(id)).toMatchObject({ status: 'ready' });
    expect(await grants()).toEqual([]); // bound to the play session, dropped once the session was stopped
  });

  it('original quality needs no slot', async () => {
    env.ctx.cfg = { ...env.ctx.cfg, CONVERSION_SLOTS: 1 };
    raw = [converting('ps-film-1')]; // budget full
    const id = await job({ quality: 'original' });
    const p = preparer(env.ctx);
    await p.tick(); await p.whenIdle();
    expect(await status(id)).toMatchObject({ status: 'ready' });
    expect(await grants()).toEqual([]);
  });

  it('unreadable session list waits, never fails', async () => {
    env.ctx.jf.admin.transcodeSessions = () => new Promise(() => undefined); // hangs
    const id = await job();
    const p = preparer(env.ctx);
    await p.tick(); await p.whenIdle();
    expect(await status(id)).toMatchObject({ status: 'queued', error: null });
    expect(await grants()).toEqual([]);
    // the list answers again: the next tick runs it
    env.ctx.jf.admin.transcodeSessions = origSessions();
    await p.tick(); await p.whenIdle();
    expect(await status(id)).toMatchObject({ status: 'ready' });
  }, 15_000);

  it('a failure before the play session is known frees the slot at once', async () => {
    failInfo = true; // the first downloadSource throws
    const id = await job();
    const p = preparer(env.ctx);
    const warn = console.warn;
    console.warn = () => undefined;
    try { await p.tick(); await p.whenIdle(); } finally { console.warn = warn; }
    expect(await status(id)).toMatchObject({ status: 'failed' });
    expect(await grants()).toEqual([]);
  });

  it('a seam restart keeps the slot: every attempt binds its own play session', async () => {
    freshPs = true;
    restartGap = 0.03;
    const pv = previews(env.ctx);
    const seen: string[][] = [];
    onSeg = (n) => {
      if (n === 0) void grants().then((g) => seen.push(g));
      if (n === 2) { pv.paused = true; setTimeout(() => { pv.paused = false; }, 15); }
    };
    const id = await job();
    const p = preparer(env.ctx);
    try { await p.tick(); await p.whenIdle(); } finally { pv.paused = false; }
    expect(await status(id)).toMatchObject({ status: 'ready' });
    expect(psCount).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(['conv:grant:ps-seam-1']);
    expect(seen[1]).toEqual(['conv:grant:ps-seam-2']); // moved over from the first attempt's session, not lost
    expect(seen[2]).toEqual(['conv:grant:ps-seam-3']);
    expect(await grants()).toEqual([]);
  });
});

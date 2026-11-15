// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputEnd, alignStart, openInput, type InputDeps, type OpenedInput, type Resume } from '../src/inputs.js';
import { parseMedia } from '../src/passthrough.js';
import type { ProbeResult } from '../src/probe.js';
import { remuxDriver } from '../src/remux.js';
import type { DriverContext } from '../src/streams.js';
import { GUARD, INPUT, ONE_MASTER, provider, reader, seqs, win, type Script } from './hls-provider.js';

/**
 * H1 (item 3): a restart resumes after the last segment each rendition delivered, while that is still in the provider's window,
 * instead of taking the newest 3 again: the segments run 1 delivered are never fed again (a replay adds its length to every
 * viewer's delay behind live).
 */
const T = Date.parse('2026-11-15T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ now: T }); });
afterEach(() => { vi.useRealTimers(); });

/** the provider's edge: 100..109 at T, one segment further every 2 s */
const moving = (prefix: string, base = 100) => () => {
  const k = Math.floor((Date.now() - T) / 2000);
  return win(base + k, base + 9 + k, { prefix });
};

async function run(script: Script, ms: number, deps: Partial<InputDeps>) {
  const p = provider(script);
  const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch, ...deps });
  if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
  const v = reader(o.ffInput.stdin);
  const a = o.ffInput.audio ? reader(o.ffInput.audio.stdin) : null;
  await vi.advanceTimersByTimeAsync(ms);
  o.close();
  await Promise.all([v.done, a?.done]);
  return { v: seqs(v.got), a: a ? seqs(a.got) : [] };
}

describe('a restart resumes', () => {
  it('one playlist: run 2 starts right after the last segment run 1 delivered', async () => {
    const resume: Resume = { video: null, audio: null };
    const script = { master: ONE_MASTER, video: moving('v') };
    const run1 = await run(script, 2_500, { resume });
    expect(run1.v).toEqual([107, 108, 109, 110]);
    expect(resume.video).toBe(110);
    // 4 s later (the backoff, ffmpeg's start): the provider is at 103..112
    await vi.advanceTimersByTimeAsync(3_500);
    const run2 = await run(script, 500, { resume });
    expect(run2.v).toEqual([111, 112]);
  });

  it('separate audio: run 2 never re-delivers what run 1 delivered, in either rendition', async () => {
    const resume: Resume = { video: null, audio: null };
    const script = { video: moving('v'), audio: moving('a') };
    const run1 = await run(script, 2_500, { resume });
    await vi.advanceTimersByTimeAsync(3_500);
    const run2 = await run(script, 4_500, { resume });
    expect(run1.v).toEqual([107, 108, 109, 110]);
    expect(run2.v).toEqual([111, 112, 113, 114]);
    expect(run2.a).toEqual([111, 112, 113, 114]);
    expect(run2.v.filter((x) => run1.v.includes(x))).toEqual([]);
    expect(run2.a.filter((x) => run1.a.includes(x))).toEqual([]);
  });

  it('renditions that stopped at different points both start after the later one (a short hole, never a replay)', async () => {
    const run2 = await run({ video: moving('v'), audio: moving('a') }, 500, { resume: { video: 108, audio: 107 } });
    expect([run2.v[0], run2.a[0]]).toEqual([109, 109]);
  });

  it('a resume point that left the window takes the newest 3; one a stale read is behind waits for the next segment', async () => {
    expect((await run({ master: ONE_MASTER, video: moving('v') }, 500, { resume: { video: 50, audio: null } })).v).toEqual([107, 108, 109]);
    expect((await run({ master: ONE_MASTER, video: moving('v') }, 6_500, { resume: { video: 111, audio: null } })).v).toEqual([112]);
  });

  it('alignStart from resume points: by sequence right after them, by date-time the first pair at or after them', () => {
    const P = (first: number, last: number, prefix: string, pdt?: number) => parseMedia(win(first, last, { prefix, ...(pdt !== undefined ? { pdt } : {}) }))!;
    expect(alignStart(P(100, 109, 'v'), P(100, 109, 'a'), { video: 104, audio: 105 })).toEqual({ video: 105, audio: 105, shift: 0, by: 'sequence' });
    expect(alignStart(P(100, 109, 'v', T), P(500, 509, 'a', T), { video: 103, audio: 503 })).toEqual({ video: 103, audio: 503, shift: 0, by: 'pdt' });
    // nothing new yet: both wait for the next segment
    expect(alignStart(P(100, 109, 'v'), P(100, 109, 'a'), { video: 110, audio: 110 })).toEqual({ video: 110, audio: 110, shift: 0, by: 'sequence' });
  });
});

describe('resume after the provider went back (review I1, M6)', () => {
  it('a resume point more than the stale tolerance ahead of the provider\'s newest starts at the edge', async () => {
    // the provider restarted at lower numbers (103..112) after the run before had delivered up to 120
    const r = await run({ video: () => win(103, 112, { prefix: 'v' }), audio: () => win(103, 112, { prefix: 'a' }) }, 500, { resume: { video: 120, audio: 120 } });
    expect([r.v, r.a]).toEqual([[110, 111, 112], [110, 111, 112]]);
  });

  it('two runs in a row after a small sequence drop: the first ends with restart and clears the resume points, the second starts at the edge', async () => {
    // the run before delivered up to 114; the provider now lists 103..112 (2 behind, within the stale tolerance) and stays there
    const resume: Resume = { video: 114, audio: 114 };
    const script = { video: () => win(103, 112, { prefix: 'v' }), audio: () => win(103, 112, { prefix: 'a' }) };
    const ends: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = provider(script);
      // the first segment is read before openInput returns (both are MPEG-TS by name): it may end in there already
      const pending: Promise<OpenedInput | unknown> = openInput(INPUT, { guard: GUARD, fetch: p.fetch, resume }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(8_000);
      const o = await pending;
      if (o instanceof InputEnd) { ends.push(o.code); continue; }
      const opened = o as OpenedInput;
      if (opened.ffInput.kind !== 'pipe' || !opened.ffInput.audio) throw new Error('pair expected');
      const v = reader(opened.ffInput.stdin);
      const a = reader(opened.ffInput.audio.stdin);
      await vi.advanceTimersByTimeAsync(8_000);
      ends.push(opened.endReason?.() ?? 'running');
      opened.close();
      await Promise.all([v.done, a.done]);
      expect(seqs(v.got)).toEqual([110, 111, 112]);
    }
    expect(ends).toEqual(['restart', 'running']);
    expect(resume).toEqual({ video: 112, audio: 112 });
  });

  it('a resume point more than 60 s behind the edge (a long provider window after a long outage) starts at the edge', async () => {
    // 4-s segments: 20 behind is 80 s of burst; the edge instead
    const long = (prefix: string) => () => win(50, 129, { prefix });
    expect((await run({ master: ONE_MASTER, video: long('v') }, 500, { resume: { video: 109, audio: null } })).v).toEqual([127, 128, 129]);
    // 10 behind (40 s) still resumes
    expect((await run({ master: ONE_MASTER, video: long('v') }, 500, { resume: { video: 119, audio: null } })).v.slice(0, 2)).toEqual([120, 121]);
  });
});

describe('the remux driver keeps the resume points across runs', () => {
  it('run 2 of the driver starts after what run 1 fed ffmpeg', async () => {
    const p = provider({ video: moving('v'), audio: moving('a') });
    const fed: string[][] = [];
    const run = vi.fn(async (_c: string, _args: string[], o: { stdin?: AsyncIterable<Uint8Array>; audioStdin?: AsyncIterable<Uint8Array> }) => {
      // ffmpeg reads two segments of each rendition, then exits
      const take = async (src?: AsyncIterable<Uint8Array>) => {
        const it = src![Symbol.asyncIterator]();
        const out: string[] = [];
        for (let i = 0; i < 2; i++) out.push(Buffer.from((await it.next()).value as Uint8Array).toString());
        return out;
      };
      fed.push([...(await take(o.stdin)), ...(await take(o.audioStdin))]);
      return { code: 1, stdout: Buffer.alloc(0), stderr: '' };
    });
    const ac = new AbortController();
    const c = {
      input: INPUT, signal: ac.signal, mode: 'remux', channelId: 'hafenkanal', maxBitrate: 10_000_000, runsAs: vi.fn(), fail: vi.fn(),
      window: vi.fn(), back: vi.fn(), lost: () => 2_000, bitrate: vi.fn(), encoder: 'libx264', dir: '/cache/k', segment: vi.fn(), log: () => {},
      sleep: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); return fed.length < 2; },
    } as unknown as DriverContext;
    const AAC: ProbeResult = { ok: true, video: { codec: 'h264', width: 1280, height: 720, fps: 25 }, audio: { codec: 'aac', channels: 2 }, needs: 'remux' };
    await remuxDriver({ run: run as never, guard: GUARD, fetch: p.fetch })(c, AAC);
    expect(fed).toEqual([['v107;', 'v108;', 'a107;', 'a108;'], ['v109;', 'v110;', 'a109;', 'a110;']]);
  });
});

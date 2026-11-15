// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { InputEnd, advanceTimeoutMs, openInput } from '../src/inputs.js';
import { STALL_MS } from '../src/remux.js';
import { GUARD, INPUT, ONE_MASTER, provider, reader, seqs, win } from './hls-provider.js';

/**
 * H2 (item 7): ffmpeg reads the two renditions in lockstep, so one whose playlist stops advancing holds the whole output. Each
 * rendition now ends the run by itself once its playlist showed nothing new for about 3 target durations (12–20 s), well before
 * the driver's 32-s stall watchdog; the restart then resumes where it was.
 */
const T = Date.parse('2026-11-15T12:00:00.000Z');
beforeEach(() => { vi.useFakeTimers({ now: T }); });
afterEach(() => { vi.useRealTimers(); });

const moving = (prefix: string, dur = 4) => () => {
  const k = Math.floor((Date.now() - T) / (dur * 500));
  return win(100 + k, 109 + k, { prefix, dur });
};
const frozen = (prefix: string, dur = 4) => () => win(100, 109, { prefix, dur });

describe('a playlist that stops advancing', () => {
  it('the timeout is 3 target durations, at least 12 s and at most 20 s', () => {
    expect([1, 2, 4, 5, 6, 7, 10].map(advanceTimeoutMs)).toEqual([12_000, 12_000, 12_000, 15_000, 18_000, 20_000, 20_000]);
    expect(advanceTimeoutMs(4)).toBeLessThan(STALL_MS);
  });

  it('a frozen audio rendition ends the pair after 12 s (target 4), long before the stall watchdog; the audio is blamed', async () => {
    const p = provider({ video: moving('v'), audio: frozen('a') });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe' || !o.ffInput.audio) throw new Error('pair expected');
    const v = reader(o.ffInput.stdin);
    const a = reader(o.ffInput.audio.stdin);
    await vi.advanceTimersByTimeAsync(11_500);
    expect([v.ended, a.ended]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([v.ended, a.ended]).toEqual([true, true]);
    expect((a.error as InputEnd).code).toBe('not_advancing');
    expect(seqs(a.got)).toEqual([107, 108, 109]);
    expect(o.audioFault?.(false)).toBe(true);
    o.close();
  });

  it('a frozen video ends it too, and is not the audio\'s fault; with 6-s segments after 18 s', async () => {
    const p = provider({ video: frozen('v', 6), audio: moving('a', 6) });
    const o = await openInput(INPUT, { guard: GUARD, fetch: p.fetch });
    if (o.ffInput.kind !== 'pipe' || !o.ffInput.audio) throw new Error('pair expected');
    const v = reader(o.ffInput.stdin);
    const a = reader(o.ffInput.audio.stdin);
    await vi.advanceTimersByTimeAsync(17_500);
    expect(v.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((v.error as InputEnd).code).toBe('not_advancing');
    expect(a.ended).toBe(true);
    expect(o.audioFault?.(false)).toBe(false);
    o.close();
  });

  it('a playlist whose polls keep failing ends the same way; one that advances never does', async () => {
    const failing = provider({ master: ONE_MASTER, video: (read) => (read === 0 ? win(100, 109, { prefix: 'v' }) : new FetchError('timeout')) });
    const o = await openInput(INPUT, { guard: GUARD, fetch: failing.fetch });
    if (o.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v = reader(o.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(12_500);
    expect((v.error as InputEnd).code).toBe('not_advancing');
    o.close();

    const fine = provider({ master: ONE_MASTER, video: moving('v') });
    const o2 = await openInput(INPUT, { guard: GUARD, fetch: fine.fetch });
    if (o2.ffInput.kind !== 'pipe') throw new Error('pipe expected');
    const v2 = reader(o2.ffInput.stdin);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(v2.ended).toBe(false);
    o2.close();
    await v2.done;
    expect(v2.error).toBeUndefined();
  });
});

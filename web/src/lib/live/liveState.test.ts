// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RunningChannel } from './api';
import { fromBeatGone, fromWatchError, LOST_GIVE_UP_MS, lostDelay, nextLost, STALL_LOST_MS, type LiveUi } from './liveState';

const at = (h: number, m: number) => new Date(2026, 10, 12, h, m, 0, 0).toISOString();
const RUNNING: RunningChannel[] = [
  { id: 'ch-nord', number: 1, name: 'Nordlicht TV', logo: '/api/livetv/logos/ch-nord.png', now: { title: 'Die Leuchtturmwärter', start: at(20, 15), end: at(21, 0) } },
  { id: 'ch-hafen', number: 4, name: 'Hafenkanal', logo: null },
];

describe('fromWatchError (every WatchError of Task 35, F23)', () => {
  it('503 live_full is the full sheet with the running channels', () => {
    expect(fromWatchError(503, { error: 'live_full', running: RUNNING })).toEqual({ k: 'full', running: RUNNING });
  });
  it('503 provider_limit carries the provider maximum and the running channels', () => {
    expect(fromWatchError(503, { error: 'provider_limit', max: 1, running: RUNNING })).toEqual({ k: 'providerLimit', max: 1, running: RUNNING });
  });
  it('502 channel_unreachable is the input-lost card "Sender gerade nicht erreichbar", attempt 0', () => {
    expect(fromWatchError(502, { error: 'channel_unreachable' })).toEqual({ k: 'unreachable', attempt: 0 });
  });
  it('404 livetv_off is the off message (no retry)', () => {
    expect(fromWatchError(404, { error: 'livetv_off' })).toEqual({ k: 'off' });
    expect(fromWatchError(404, { error: 'livetv_off' }, { again: false })).toEqual({ k: 'off' });
  });
  it('404 livetv_off for the channel that was already playing is a transient loss with reconnects (bughunt M1)', () => {
    expect(fromWatchError(404, { error: 'livetv_off' }, { again: true })).toEqual({ k: 'unreachable', attempt: 0 });
    // the other refusals mean the same as on a first watch
    expect(fromWatchError(404, { error: 'not_found' }, { again: true })).toEqual({ k: 'forbidden' });
    expect(fromWatchError(403, { error: 'forbidden' }, { again: true })).toEqual({ k: 'forbidden' });
  });
  it('409 not_receiving waits for the push feed', () => {
    expect(fromWatchError(409, { error: 'not_receiving' })).toEqual({ k: 'notReceiving' });
  });
  it('409 stopped_by_admin is the stopped card without reconnects, also for the channel that was playing (bughunt L3)', () => {
    expect(fromWatchError(409, { error: 'stopped_by_admin' })).toEqual({ k: 'stopped' });
    expect(fromWatchError(409, { error: 'stopped_by_admin' }, { again: true })).toEqual({ k: 'stopped' });
  });
  it('429 max_streams is the film player\'s max-streams message with its maximum', () => {
    expect(fromWatchError(429, { error: 'max_streams', max: 2 })).toEqual({ k: 'maxStreams', max: 2 });
  });
  it('403 and every other 404 are forbidden', () => {
    expect(fromWatchError(403, { error: 'forbidden' })).toEqual({ k: 'forbidden' });
    expect(fromWatchError(403, null)).toEqual({ k: 'forbidden' });
    expect(fromWatchError(404, { error: 'not_found' })).toEqual({ k: 'forbidden' });
    expect(fromWatchError(404, 'not json')).toEqual({ k: 'forbidden' });
  });
  it('a malformed running list or maximum is read safely', () => {
    expect(fromWatchError(503, { error: 'live_full', running: 'x' })).toEqual({ k: 'full', running: [] });
    expect(fromWatchError(503, { error: 'provider_limit', max: '3' })).toEqual({ k: 'providerLimit', max: 0, running: [] });
    expect(fromWatchError(429, { error: 'max_streams' })).toEqual({ k: 'maxStreams', max: 0 });
  });
  it('anything unexpected is the input-lost state with its retries, never a dead end', () => {
    expect(fromWatchError(500, { error: 'boom' })).toEqual({ k: 'lost', attempt: 0 });
    expect(fromWatchError(502, { error: 'bad_gateway' })).toEqual({ k: 'lost', attempt: 0 });
    expect(fromWatchError(503, null)).toEqual({ k: 'lost', attempt: 0 });
  });
});

describe('lostDelay', () => {
  it('waits 2, 4, 8, 16, 30, 60 s (ms)', () => {
    expect([0, 1, 2, 3, 4, 5].map(lostDelay)).toEqual([2000, 4000, 8000, 16_000, 30_000, 60_000]);
  });
  it('stays at 60 s beyond and never goes below 2 s', () => {
    expect(lostDelay(6)).toBe(60_000);
    expect(lostDelay(40)).toBe(60_000);
    expect(lostDelay(-1)).toBe(2000);
  });
  it('a playlist stall longer than 8 s counts as input lost', () => {
    expect(STALL_LOST_MS).toBe(8000);
  });
});

describe('nextLost: the 2-min switch to retry', () => {
  it('the six waits add up to two minutes, then Erneut versuchen', () => {
    expect(LOST_GIVE_UP_MS).toBe(120_000);
    let ui: LiveUi = fromWatchError(502, { error: 'channel_unreachable' });
    let elapsed = 0;
    const waits: number[] = [];
    while (ui.k === 'unreachable' || ui.k === 'lost') {
      const d = lostDelay(ui.attempt);
      waits.push(d);
      elapsed += d;
      ui = nextLost(ui, elapsed);
      if (waits.length > 20) break;
    }
    expect(waits).toEqual([2000, 4000, 8000, 16_000, 30_000, 60_000]);
    expect(ui).toEqual({ k: 'retry' });
  });
  it('keeps the kind and counts the attempt up while under two minutes', () => {
    expect(nextLost({ k: 'unreachable', attempt: 0 }, 2000)).toEqual({ k: 'unreachable', attempt: 1 });
    expect(nextLost({ k: 'lost', attempt: 3 }, 119_999)).toEqual({ k: 'lost', attempt: 4 });
    expect(nextLost({ k: 'lost', attempt: 3 }, 120_000)).toEqual({ k: 'retry' });
    expect(nextLost({ k: 'unreachable', attempt: 0 }, 200_000)).toEqual({ k: 'retry' });
  });
});

describe('fromBeatGone (bughunt L4)', () => {
  it('a token another window replaced is elsewhere; any other 410 is gone', () => {
    expect(fromBeatGone({ error: 'gone', reason: 'replaced' })).toBe('elsewhere');
    expect(fromBeatGone({ error: 'gone' })).toBe('gone');
    expect(fromBeatGone(null)).toBe('gone');
    expect(fromBeatGone('replaced')).toBe('gone');
  });
});

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatProbe, runProbe, shouldProbe, type ProbeDeps } from './probe';

type L = Record<string, (...a: any[]) => void>;
function avplay(mode: 'ok' | 'error' | 'never' | 'prepareError') {
  let l: L = {}; let state = 'NONE';
  const calls: string[] = [];
  return {
    calls, state: () => state,
    open: vi.fn((u: string) => { calls.push('open:' + u); state = 'IDLE'; }),
    setListener: vi.fn((x: L) => { l = x; }),
    prepareAsync: vi.fn((ok: () => void, err: (e: unknown) => void) => { state = 'READY'; if (mode === 'prepareError') err({ name: 'PLAYER_ERROR_INVALID_URI' }); else ok(); }),
    play: vi.fn(() => {
      calls.push('play');
      if (mode === 'error') l.onerror?.('PLAYER_ERROR_CONNECTION_FAILED');
      else if (mode === 'ok') { state = 'PLAYING'; l.oncurrentplaytime?.(100); }
    }),
    stop: vi.fn(() => calls.push('stop')), close: vi.fn(() => calls.push('close')), getState: () => state,
  };
}
function mk(o: { av?: ReturnType<typeof avplay> | null; key?: boolean; app?: boolean; target?: 'ok' | 'unpaired' | 'fail'; regKey?: boolean } = {}) {
  const av = o.av === undefined ? avplay('ok') : o.av;
  const report = vi.fn(async () => undefined);
  let t = 1000;
  const deps: ProbeDeps = {
    webapis: av ? { avplay: av, productinfo: { getModel: () => 'QE55Q80B' } } : undefined,
    tizen: {
      tvinputdevice: { registerKey: o.regKey === false ? () => { throw new Error('x'); } : () => undefined, getKey: () => ({ code: 10252 }) },
      application: o.app === false ? undefined : { getCurrentApplication: () => ({}) },
      systeminfo: { getCapability: () => '6.5' },
    },
    fetchInfo: vi.fn(async () => {
      if (o.target === 'unpaired') throw Object.assign(new Error('u'), { code: 'unpaired' });
      if (o.target === 'fail') throw new Error('boom');
      return { url: 'https://friend.example.com/s.mp4', report };
    }),
    now: () => (t += 1155),
    waitKey: vi.fn(async () => o.key !== false),
  };
  return { deps, av, report };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runProbe', () => {
  it('all ok gives the exact line', async () => {
    const { deps, av, report } = mk();
    const r = await runProbe(deps);
    expect(formatProbe(r)).toBe('FFPROBE v1 avplay=ok play=ok:1155ms keys=ok app=ok tizen=6.5 model=QE55Q80B');
    expect(av!.calls).toEqual(['open:https://friend.example.com/s.mp4', 'play', 'stop', 'close']);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('missing webapis gives avplay=missing play=skipped', async () => {
    const { deps } = mk({ av: null });
    expect(formatProbe(await runProbe(deps))).toBe('FFPROBE v1 avplay=missing play=skipped keys=ok app=ok tizen=6.5 model=?');
    expect(deps.fetchInfo).not.toHaveBeenCalled();
  });
  it('an AVPlay error callback gives play=error:<code> and still reports the stop once', async () => {
    const { deps, report } = mk({ av: avplay('error') });
    expect(formatProbe(await runProbe(deps))).toContain('play=error:PLAYER_ERROR_CONNECTION_FAILED');
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('a prepare error gives its name', async () => {
    const { deps, report } = mk({ av: avplay('prepareError') });
    expect(formatProbe(await runProbe(deps))).toContain('play=error:PLAYER_ERROR_INVALID_URI');
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('no PLAYING within 15 s gives play=error:timeout', async () => {
    const { deps, av, report } = mk({ av: avplay('never') });
    const p = runProbe(deps);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(av!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(formatProbe(await p)).toContain('play=error:timeout');
    expect(av!.calls.slice(-2)).toEqual(['stop', 'close']);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('unpaired TV gives play=error:unpaired without opening anything', async () => {
    const { deps, av, report } = mk({ target: 'unpaired' });
    expect(formatProbe(await runProbe(deps))).toContain('play=error:unpaired');
    expect(av!.open).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
  it('another lookup failure gives play=error:info', async () => {
    expect(formatProbe(await runProbe(mk({ target: 'fail' }).deps))).toContain('play=error:info');
  });
  it('key not pressed gives keys=timeout (20 s asked); a register error gives keys=error', async () => {
    const a = mk({ key: false });
    expect(formatProbe(await runProbe(a.deps))).toContain('keys=timeout');
    expect(a.deps.waitKey).toHaveBeenCalledWith(20_000);
    expect(formatProbe(await runProbe(mk({ regKey: false }).deps))).toContain('keys=error');
  });
  it('app=missing without the application API; unknown tizen version and model are ?', async () => {
    const { deps } = mk({ app: false });
    deps.tizen!.systeminfo = undefined;
    expect(formatProbe(await runProbe(deps))).toContain('app=missing tizen=? model=QE55Q80B');
  });
});

describe('shouldProbe', () => {
  const w = (o: { ua?: string; search?: string; flag?: string }) => {
    const m = new Map<string, string>(o.flag ? [['ff.probe', o.flag]] : []);
    return { navigator: { userAgent: o.ua ?? '' }, location: { search: o.search ?? '' }, sessionStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }, m };
  };
  const APP = ' FriendFlixTizen/1';
  it('needs the app and probe=1 (or the remembered flag, which probe=1 sets)', () => {
    const a = w({ ua: APP, search: '?probe=1' });
    expect(shouldProbe(a)).toBe(true);
    expect(a.m.get('ff.probe')).toBe('1');
    expect(shouldProbe(w({ ua: APP, flag: '1' }))).toBe(true);
    expect(shouldProbe(w({ ua: APP }))).toBe(false);
    expect(shouldProbe(w({ search: '?probe=1' }))).toBe(false);
  });
});

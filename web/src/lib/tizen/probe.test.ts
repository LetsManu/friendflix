// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failedProbeLine, formatProbe, missingTizenLine, realDeps, runProbe, shouldEndProbe, shouldProbe, type ProbeDeps } from './probe';

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
    setDisplayRect: vi.fn((...a: number[]) => calls.push('rect:' + a.join(','))),
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
    expect(av!.calls).toEqual(['open:https://friend.example.com/s.mp4', 'rect:0,0,1920,1080', 'play', 'stop', 'close']);
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


describe('probe surface, report timeout, profile', () => {
  it('creates the hidden video surface before open and removes it after close, also on errors', async () => {
    for (const mode of ['ok', 'error'] as const) {
      const { deps, av } = mk({ av: avplay(mode) });
      const order: string[] = [];
      deps.surface = { create: () => order.push('create'), remove: () => order.push('remove') };
      av!.open.mockImplementation((u: string) => { order.push('open'); av!.calls.push('open:' + u); });
      av!.close.mockImplementation(() => order.push('close'));
      await runProbe(deps);
      expect(order).toEqual(['create', 'open', 'close', 'remove']);
    }
  });
  it('a report that never answers does not hold the probe (5 s)', async () => {
    const { deps, report } = mk();
    report.mockImplementation(() => new Promise(() => undefined));
    const p = runProbe(deps);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(formatProbe(await p)).toContain('play=ok:');
  });
  it('a profile error from the lookup gives play=error:profile', async () => {
    const { deps } = mk();
    deps.fetchInfo = vi.fn(async () => { throw Object.assign(new Error('p'), { code: 'profile' }); });
    expect(formatProbe(await runProbe(deps))).toContain('play=error:profile');
  });
});

describe('realDeps lookup', () => {
  const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
  function setup(over: Record<string, () => unknown> = {}, info: Record<string, unknown> = {}) {
    const calls: { path: string; init: any }[] = [];
    const answers: Record<string, () => unknown> = {
      '/api/me': () => json(200, { tv: true, csrfToken: 'tok-1' }),
      '/api/library/resume': () => json(200, { items: [{ id: 'i1' }] }),
      '/api/playback/info': () => json(200, { playSessionId: 'ps', mediaSourceId: 'ms', directUrl: '/media/x.mp4', hlsUrl: '/h.m3u8', ...info }),
      '/api/playback/stop': () => json(204, null),
      ...over,
    };
    const fetchImpl = (async (path: string, init: any) => { calls.push({ path, init }); return answers[path]!(); }) as unknown as typeof fetch;
    const win = { location: { origin: 'https://friend.example.com' }, document: {}, addEventListener() {}, removeEventListener() {} } as any;
    return { calls, deps: realDeps(win, fetchImpl) };
  }
  it('takes the CSRF token from its own /api/me answer and sends the title\'s resume point in the stop report', async () => {
    const { calls, deps } = setup({}, { resumeTicks: 4_200_000_000 });
    const t = await deps.fetchInfo();
    expect(t.url).toBe('https://friend.example.com/media/x.mp4');
    expect(calls.find((c) => c.path === '/api/playback/info')!.init.headers['x-csrf-token']).toBe('tok-1');
    await t.report();
    const stop = calls.find((c) => c.path === '/api/playback/stop')!;
    expect(stop.init.headers['x-csrf-token']).toBe('tok-1');
    expect(JSON.parse(stop.init.body)).toMatchObject({ itemId: 'i1', playSessionId: 'ps', positionTicks: 4_200_000_000 });
  });
  it('sends 0 when the info has no resume point', async () => {
    const { calls, deps } = setup();
    await (await deps.fetchInfo()).report();
    expect(JSON.parse(calls.find((c) => c.path === '/api/playback/stop')!.init.body).positionTicks).toBe(0);
  });
  it('maps 409 profile_required / profile_changed to code profile without any redirect', async () => {
    for (const [path, error] of [['/api/library/resume', 'profile_required'], ['/api/playback/info', 'profile_changed']] as const) {
      const { deps } = setup({ [path]: () => json(409, { error }) });
      await expect(deps.fetchInfo()).rejects.toMatchObject({ code: 'profile' });
    }
  });
  it('an unpaired TV rejects with code unpaired', async () => {
    const { deps } = setup({ '/api/me': () => json(200, { tv: false }) });
    await expect(deps.fetchInfo()).rejects.toMatchObject({ code: 'unpaired' });
  });
});

describe('tizen=missing line, end rule, failure line', () => {
  const w = (search: string, extra: object = {}) => ({ navigator: { userAgent: '' }, location: { search }, ...extra });
  it('shows nothing without ff_app or probe=1, or when tizen exists', () => {
    expect(missingTizenLine(w('?probe=1'))).toBeNull();
    expect(missingTizenLine(w('?ff_app=tizen'))).toBeNull();
    expect(missingTizenLine(w(''))).toBeNull();
    expect(missingTizenLine(w('?probe=1&ff_app=tizen', { tizen: {} }))).toBeNull();
  });
  it('probe=1 and ff_app=tizen without a tizen global shows the tizen=missing line', () => {
    expect(missingTizenLine(w('?probe=1&ff_app=tizen'))).toBe('FFPROBE v1 avplay=missing play=skipped keys=skipped app=missing tizen=missing model=?');
    expect(missingTizenLine(w('?ff_app=tizen&probe=1', { webapis: { avplay: {} } }))).toBe('FFPROBE v1 avplay=ok play=skipped keys=skipped app=missing tizen=missing model=?');
  });
  it('does not turn anything else on (no detection flag, no probe flag)', () => {
    const set = vi.fn();
    const win = w('?probe=1&ff_app=tizen', { sessionStorage: { getItem: () => null, setItem: set } });
    missingTizenLine(win);
    expect(set).not.toHaveBeenCalled();
    expect(shouldProbe(win)).toBe(false);
  });
  it('the compact strip keeps the probe alive while unpaired; everything else ends it', () => {
    expect(shouldEndProbe(true, 'FFPROBE v1 avplay=ok play=error:unpaired keys=ok app=ok tizen=6.5 model=?')).toBe(false);
    expect(shouldEndProbe(false, 'FFPROBE v1 avplay=ok play=error:unpaired keys=ok app=ok tizen=6.5 model=?')).toBe(true);
    expect(shouldEndProbe(true, 'FFPROBE v1 avplay=ok play=ok:10ms keys=ok app=ok tizen=6.5 model=?')).toBe(true);
  });
  it('a crashed probe still shows a line with play=error:unknown', () => {
    expect(failedProbeLine({ webapis: { avplay: {} } } as any)).toBe('FFPROBE v1 avplay=ok play=error:unknown keys=skipped app=missing tizen=? model=?');
  });
});

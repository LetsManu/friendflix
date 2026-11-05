// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./caps', async (orig) => ({ ...(await orig<typeof import('./caps')>()), lgCaps: vi.fn(() => null) }));
import { fetchProbeTarget } from '#lib/tvprobe/target';
import { CANDIDATES, lgCaps } from './caps';
import { failedLgProbeLine, formatLgProbe, realLgDeps, runLgProbe, shouldLgProbe, type LgProbeDeps, type LgProbeStage, type ProbeVideo } from './probe';

type Mode = 'ok' | 'never' | 'error';
/** a fake <video>: 'ok' fires loadeddata and playing on play(), 'error' fires error with MediaError code 3 */
function fakeVideo(mode: () => Mode, log: string[]) {
  return (): ProbeVideo => {
    const on: Record<string, Array<() => void>> = {};
    const fire = (t: string) => (on[t] ?? []).forEach((f) => f());
    const v: ProbeVideo = {
      src: '', muted: false, error: null,
      addEventListener: (t: string, f: () => void) => { (on[t] ??= []).push(f); },
      play: () => {
        log.push('play:' + v.src);
        const m = mode();
        if (m === 'ok') queueMicrotask(() => { fire('loadeddata'); fire('playing'); });
        else if (m === 'error') queueMicrotask(() => { v.error = { code: 3 }; fire('error'); });
        return Promise.resolve();
      },
      remove: () => { log.push('remove'); },
    };
    return v;
  };
}

function mk(o: {
  direct?: Mode; hls?: Mode | { error: string } | { reject: string }; nativehls?: Mode;
  keys?: { playpause?: boolean; red?: boolean }; search?: string; stored?: Record<string, string>; home?: boolean;
  target?: 'ok' | 'unpaired'; noDirect?: boolean; media?: string[];
} = {}) {
  const log: string[] = [];
  const store = new Map<string, string>(Object.entries(o.stored ?? {}));
  const report = vi.fn(async () => undefined);
  let current: 'direct' | 'hls' | 'nativehls' = 'direct';
  let t = 1000;
  const hlsMode = o.hls ?? 'ok';
  const deps: LgProbeDeps = {
    media: { canPlayType: (m) => ((o.media ?? [CANDIDATES.video.h264[2]!.mime, CANDIDATES.audio.aac, CANDIDATES.containers.mp4]).includes(m) ? 'maybe' : '') },
    os: '25',
    palm: true,
    fetchTarget: vi.fn(async () => {
      if (o.target === 'unpaired') throw Object.assign(new Error('u'), { code: 'unpaired' });
      if (o.noDirect) return { url: 'https://friend.example.com/h.m3u8', hlsUrl: 'https://friend.example.com/h.m3u8', direct: false, report };
      return { url: 'https://friend.example.com/d.mp4', hlsUrl: 'https://friend.example.com/h.m3u8', direct: true, report };
    }),
    now: () => (t += 1840),
    createVideo: fakeVideo(() => (current === 'direct' ? o.direct ?? 'ok' : current === 'hls' ? (typeof hlsMode === 'string' ? hlsMode : 'never') : o.nativehls ?? 'ok'), log),
    startHls: vi.fn(async (v: ProbeVideo, url: string, onError: (code: string) => void) => {
      log.push('hls:' + url);
      if (typeof hlsMode === 'object' && 'reject' in hlsMode) throw Object.assign(new Error('x'), { code: hlsMode.reject });
      if (typeof hlsMode === 'object' && 'error' in hlsMode) queueMicrotask(() => onError(hlsMode.error));
      return () => log.push('hls:destroy');
    }),
    waitKey: vi.fn(async (codes: number[]) => (codes.includes(403) ? o.keys?.red !== false : o.keys?.playpause !== false)),
    search: o.search ?? '?probe=1&ff_app=webos',
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    goHome: vi.fn(() => o.home !== false),
  };
  const stages: string[] = [];
  const onStage = (s: LgProbeStage, d?: string) => {
    stages.push(d ? `${s}:${d}` : s);
    if (s === 'direct') current = 'direct';
    if (s === 'hls') current = d === 'native' ? 'nativehls' : 'hls';
  };
  return { deps, log, store, report, stages, onStage };
}

/** runs the probe; the home stage waits 3 s for the page to leave, which the fake timers skip */
async function run(m: ReturnType<typeof mk>) {
  const p = runLgProbe(m.deps, m.onStage);
  await vi.advanceTimersByTimeAsync(3_100);
  return p;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const SPEC = {
  os: '25', direct: 'ok:1840ms', hls: 'ok', nativehls: 'ok', palm: 'yes', home: 'ok', keys: 'ok',
  video: ['h264', 'hevc', 'av1', 'vp9'], audio: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus'], containers: ['mkv', 'mp4', 'ts', 'webm'],
} as const;

describe('formatLgProbe', () => {
  it('prints the spec example line exactly', () => {
    expect(formatLgProbe({ ...SPEC, video: [...SPEC.video], audio: [...SPEC.audio], containers: [...SPEC.containers] })).toBe(
      'FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=h264,hevc,av1,vp9 audio=aac,ac3,eac3,mp3,flac,opus containers=mkv,mp4,ts,webm',
    );
  });
  it('prints the 10-bit suffix where the runner set it', () => {
    expect(formatLgProbe({ ...SPEC, video: ['h264+10', 'hevc+10', 'av1', 'vp9'], audio: [...SPEC.audio], containers: [...SPEC.containers] })).toBe(
      'FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=h264+10,hevc+10,av1,vp9 audio=aac,ac3,eac3,mp3,flac,opus containers=mkv,mp4,ts,webm',
    );
  });
  it('an empty list prints -', () => {
    expect(formatLgProbe({ ...SPEC, video: [], audio: [], containers: [] })).toMatch(/ video=- audio=- containers=-$/);
  });
  it('a crashed probe still shows a line', () => {
    expect(failedLgProbeLine({ navigator: { userAgent: 'Web0S webOSTV/6.0' }, PalmSystem: {} })).toBe(
      'FFPROBE v1 tv=webos os=6.0 direct=error:unknown hls=skipped nativehls=skipped palm=yes home=skipped keys=skipped video=- audio=- containers=-',
    );
  });
});

describe('runLgProbe', () => {
  it('all ok: formats, three playbacks on one hidden video each, keys, then the home stage', async () => {
    const m = mk();
    const r = await run(m);
    expect(r).toMatchObject({ os: '25', direct: 'ok:1840ms', hls: 'ok', nativehls: 'ok', palm: 'yes', keys: 'ok', video: ['h264'], audio: ['aac'], containers: ['mp4'] });
    expect(m.log).toEqual([
      'play:https://friend.example.com/d.mp4', 'remove',
      'hls:https://friend.example.com/h.m3u8', 'play:', 'hls:destroy', 'remove',
      'play:https://friend.example.com/h.m3u8', 'remove',
    ]);
    expect(m.report).toHaveBeenCalledTimes(1);
    expect(m.deps.waitKey).toHaveBeenNthCalledWith(1, [10252, 415, 19], 20_000);
    expect(m.deps.waitKey).toHaveBeenNthCalledWith(2, [403], 20_000);
    expect(m.stages).toEqual(['formats', 'direct', 'hls', 'hls:native', 'keys:playpause', 'keys:red', 'home', 'done']);
  });
  it('direct play without picture within 15 s gives direct=error:timeout', async () => {
    const m = mk({ direct: 'never' });
    const p = runLgProbe(m.deps, m.onStage);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(m.log).toEqual(['play:https://friend.example.com/d.mp4']);
    await vi.advanceTimersByTimeAsync(3_200);
    const r = await p;
    expect(r.direct).toBe('error:timeout');
    expect(r.hls).toBe('ok');
    expect(m.log[1]).toBe('remove');
  });
  it('no direct URL from the server gives direct=error:nodirect and plays nothing for that check', async () => {
    const m = mk({ noDirect: true });
    const r = await run(m);
    expect(r.direct).toBe('error:nodirect');
    expect(r.hls).toBe('ok');
    expect(r.nativehls).toBe('ok');
    expect(m.log).toEqual(['hls:https://friend.example.com/h.m3u8', 'play:', 'hls:destroy', 'remove', 'play:https://friend.example.com/h.m3u8', 'remove']);
    expect(m.report).toHaveBeenCalledTimes(1);
  });
  it('video= marks a codec with +10 when any 10-bit profile of it is confirmed', async () => {
    const v = CANDIDATES.video;
    const m = mk({ media: [v.h264[0]!.mime, v.h264[4]!.mime, v.hevc[1]!.mime, v.av1[0]!.mime, v.vp9[0]!.mime] });
    expect((await run(m)).video).toEqual(['h264+10', 'hevc+10', 'av1', 'vp9']);
  });
  it('a media error gives its name', async () => {
    expect((await run(mk({ nativehls: 'error' }))).nativehls).toBe('error:decode');
  });
  it('a fatal hls.js error gives hls=error:<code>; a failed hls.js start gives its code', async () => {
    const a = mk({ hls: { error: 'manifestLoadError' } });
    const r = await run(a);
    expect(r.hls).toBe('error:manifestLoadError');
    expect(a.log).toContain('hls:destroy');
    expect((await run(mk({ hls: { reject: 'unsupported' } }))).hls).toBe('error:unsupported');
  });
  it('no keys pressed gives keys=missing:playpause,red; one missing names it', async () => {
    expect((await run(mk({ keys: { playpause: false, red: false } }))).keys).toBe('missing:playpause,red');
    expect((await run(mk({ keys: { red: false } }))).keys).toBe('missing:red');
  });
  it('the home stage stores the result so far in ff.lgProbe and calls goToAppHome', async () => {
    const m = mk();
    const p = runLgProbe(m.deps, m.onStage);
    await vi.advanceTimersByTimeAsync(10);
    expect(m.deps.goHome).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(m.store.get('ff.lgProbe')!);
    expect(stored).toMatchObject({ direct: 'ok:1840ms', keys: 'ok', video: ['h264'], stage: 'home' }); // the restore path reads stage
    await vi.advanceTimersByTimeAsync(3_100);
    expect((await p).home).toBe('fail'); // the page was still there after 3 s
  });
  it('goToAppHome returning false gives home=fail at once', async () => {
    const m = mk({ home: false });
    const p = runLgProbe(m.deps, m.onStage);
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).home).toBe('fail');
    expect(JSON.parse(m.store.get('ff.lgProbe')!)).toMatchObject({ home: 'fail', stage: 'done' });
  });
  it('home=ok in the URL with a stored result prints the restored line and runs no playback', async () => {
    const stored = { ...SPEC, home: 'fail', video: ['vp9'], audio: [], containers: ['webm'] };
    const m = mk({ search: '?probe=1&ff_app=webos&home=ok', stored: { 'ff.lgProbe': JSON.stringify(stored) } });
    const r = await runLgProbe(m.deps, m.onStage);
    expect(formatLgProbe(r)).toBe('FFPROBE v1 tv=webos os=25 direct=ok:1840ms hls=ok nativehls=ok palm=yes home=ok keys=ok video=vp9 audio=- containers=webm');
    expect(m.deps.fetchTarget).not.toHaveBeenCalled();
    expect(m.log).toEqual([]);
    expect(m.deps.waitKey).not.toHaveBeenCalled();
    expect(m.deps.goHome).not.toHaveBeenCalled();
    expect(m.stages).toEqual(['done']);
    expect(JSON.parse(m.store.get('ff.lgProbe')!)).toMatchObject({ home: 'ok', stage: 'done' }); // kept for the reload /tv makes to /
  });
  it('a finished stored result is shown again after a reload without home=ok, with no playback', async () => {
    const stored = { ...SPEC, home: 'ok', stage: 'done' };
    const m = mk({ search: '', stored: { 'ff.lgProbe': JSON.stringify(stored) } });
    const r = await runLgProbe(m.deps, m.onStage);
    expect(r.home).toBe('ok');
    expect(m.deps.fetchTarget).not.toHaveBeenCalled();
    expect(m.deps.goHome).not.toHaveBeenCalled();
  });
  it('landing on a server page instead of the start page (stored, still waiting, no home=ok) gives home=fail', async () => {
    const stored = { ...SPEC, home: 'fail', stage: 'home' };
    const m = mk({ search: '', stored: { 'ff.lgProbe': JSON.stringify(stored) } });
    const r = await runLgProbe(m.deps, m.onStage);
    expect(r.home).toBe('fail');
    expect(m.deps.fetchTarget).not.toHaveBeenCalled();
    expect(m.deps.goHome).not.toHaveBeenCalled();
  });
  it('a broken stored value is ignored and the probe runs', async () => {
    const m = mk({ search: '?probe=1&home=ok', stored: { 'ff.lgProbe': '{nope' } });
    const r = await run(m);
    expect(r.direct).toBe('ok:1840ms');
    expect(r.home).toBe('ok');
  });
  it('home=ok without a stored result runs the checks and does not leave again', async () => {
    const m = mk({ search: '?probe=1&home=ok' });
    const r = await run(m);
    expect(r.home).toBe('ok');
    expect(r.direct).toBe('ok:1840ms');
    expect(m.deps.goHome).not.toHaveBeenCalled();
  });
  it('an unpaired TV reports it on all three playbacks and skips the keys and the home stage', async () => {
    const m = mk({ target: 'unpaired' });
    const r = await run(m);
    expect(r).toMatchObject({ direct: 'error:unpaired', hls: 'error:unpaired', nativehls: 'error:unpaired', keys: 'skipped', home: 'skipped' });
    expect(m.log).toEqual([]);
    expect(m.deps.goHome).not.toHaveBeenCalled();
  });
  it('never calls a progress endpoint: only /api/me, the library, /api/playback/info and /api/playback/stop', async () => {
    const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
    const urls: string[] = [];
    const fetchImpl = (async (path: string) => {
      urls.push(path);
      if (path === '/api/me') return json(200, { tv: true, csrfToken: 't' });
      if (path === '/api/library/resume') return json(200, { items: [] });
      if (path.startsWith('/api/library/items')) return json(200, { items: [{ id: 'i1' }] });
      if (path === '/api/playback/info') return json(200, { playSessionId: 'ps', mediaSourceId: 'ms', directUrl: '/d.mp4', hlsUrl: '/h.m3u8', resumeTicks: 5 });
      return json(204, null);
    }) as unknown as typeof fetch;
    const m = mk();
    m.deps.fetchTarget = () => fetchProbeTarget({ location: { origin: 'https://friend.example.com' } }, fetchImpl, { caps: { client: 'webos' } });
    await run(m);
    expect(urls).toEqual(['/api/me', '/api/library/resume', '/api/library/items?types=Movie,Episode&sort=DateCreated&desc=true&limit=1', '/api/playback/info', '/api/playback/stop']);
  });
});

describe('shouldLgProbe', () => {
  const w = (o: { ua?: string; search?: string; flag?: string }) => {
    const m = new Map<string, string>(o.flag ? [['ff.probe', o.flag]] : []);
    return { navigator: { userAgent: o.ua ?? '' }, location: { search: o.search ?? '' }, sessionStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }, m };
  };
  const LG = 'Mozilla/5.0 (Web0S; Linux/SmartTV) webOSTV/6.0';
  it('needs the LG app and probe=1 (or the remembered flag, which probe=1 sets)', () => {
    const a = w({ ua: LG, search: '?ff_app=webos&probe=1' });
    expect(shouldLgProbe(a)).toBe(true);
    expect(a.m.get('ff.probe')).toBe('1');
    expect(shouldLgProbe(w({ ua: LG, search: '?ff_app=webos', flag: '1' }))).toBe(true);
    expect(shouldLgProbe(w({ ua: LG, search: '?ff_app=webos' }))).toBe(false);
    expect(shouldLgProbe(w({ ua: LG, search: '?probe=1' }))).toBe(false); // the LG browser is not the app
    expect(shouldLgProbe(w({ search: '?ff_app=webos&probe=1' }))).toBe(false);
  });
});

describe('realLgDeps', () => {
  it('fetchTarget sends the lgCaps() block in the /api/playback/info body', async () => {
    const caps = { client: 'webos', appVersion: '1.0.0', containers: ['mp4'], video: [{ codec: 'h264' }], audio: ['aac'], subtitles: ['srt'] };
    vi.mocked(lgCaps).mockReturnValue(caps as any);
    const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
    const bodies: Record<string, unknown> = {};
    const fetchImpl = (async (path: string, init: any) => {
      if (init?.body) bodies[path] = JSON.parse(init.body);
      if (path === '/api/me') return json(200, { tv: true, csrfToken: 't' });
      if (path === '/api/library/resume') return json(200, { items: [{ id: 'i1' }] });
      return json(200, { playSessionId: 'ps', mediaSourceId: 'ms', directUrl: '/d.mp4', hlsUrl: '/h.m3u8' });
    }) as unknown as typeof fetch;
    const win = {
      location: { origin: 'https://friend.example.com', search: '?ff_app=webos&probe=1' },
      navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) webOSTV/6.0' },
      document: { createElement: () => ({ canPlayType: () => '' }) },
      sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    } as any;
    const deps = realLgDeps(win, fetchImpl);
    expect(deps.os).toBe('6.0');
    const t = await deps.fetchTarget();
    expect(t.direct).toBe(true);
    expect(bodies['/api/playback/info']).toEqual({ itemId: 'i1', reasonHint: 'network', caps });
    vi.mocked(lgCaps).mockReturnValue(null);
  });
});

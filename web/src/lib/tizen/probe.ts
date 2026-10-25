// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The phase-0 probe of the Samsung TV app (spec section 2): on `/tv?probe=1` inside the app it checks AVPlay, one test playback,
 * a remote key and the application API, and condenses the answer into ONE line the owner can read out or photograph:
 *
 *   FFPROBE v1 avplay=<ok|missing> play=<ok:<ms>ms|error:<code>|skipped> keys=<ok|error|timeout> app=<ok|missing> tizen=<ver|?> model=<model|?>
 *
 * `play=error:<code>` carries the AVPlay error name, or `timeout` (no PLAYING within 15 s), `unpaired` (the TV is not paired, so
 * there is nothing to play), `info` (the stream lookup failed) or `open` (AVPlay refused the URL). Everything the probe touches is
 * injected through ProbeDeps so the tests need no TV.
 */
import { api } from '#lib/api';
import { isTizenApp, type TizenWin } from './detect';

export const PLAY_TIMEOUT_MS = 15_000;
export const KEY_TIMEOUT_MS = 20_000;
export const PROBE_FLAG = 'ff.probe';

type Fn = (...a: any[]) => any;
export interface AvPlayLike {
  open: Fn; setListener: Fn; prepareAsync: Fn; play: Fn; stop: Fn; close: Fn; getState: () => string;
}
export interface WebApisLike { avplay?: AvPlayLike; productinfo?: { getModel?: () => string } }
export interface TizenLike {
  tvinputdevice?: { registerKey: (name: string) => void; getKey?: (name: string) => { code: number } };
  application?: { getCurrentApplication?: () => unknown };
  systeminfo?: { getCapability?: (key: string) => string };
}
/** what the play check needs: the stream URL and the function that tells the server the play session ended */
export interface ProbeTarget { url: string; report: () => Promise<unknown> }
export interface ProbeDeps {
  webapis?: WebApisLike;
  tizen?: TizenLike;
  /** rejects with `code: 'unpaired'` when the TV has no session */
  fetchInfo: () => Promise<ProbeTarget>;
  now: () => number;
  /** resolves true on the MediaPlayPause key press, false after the timeout */
  waitKey: (timeoutMs: number) => Promise<boolean>;
}
export type ProbeStage = 'play' | 'key' | 'done';
export interface ProbeResult {
  avplay: 'ok' | 'missing';
  play: string; // ok:<ms>ms | error:<code> | skipped
  keys: 'ok' | 'error' | 'timeout';
  app: 'ok' | 'missing';
  tizen: string; model: string;
}

export function formatProbe(r: ProbeResult): string {
  return `FFPROBE v1 avplay=${r.avplay} play=${r.play} keys=${r.keys} app=${r.app} tizen=${r.tizen} model=${r.model}`;
}

const token = (v: unknown, fallback: string) => String(v ?? '').trim().replace(/\s+/g, '_') || fallback;
const errCode = (e: unknown, fallback: string) => token(typeof e === 'string' ? e : (e as { name?: string; code?: string } | null)?.name ?? (e as { code?: string } | null)?.code, fallback);

async function playCheck(av: AvPlayLike, deps: ProbeDeps): Promise<string> {
  let target: ProbeTarget;
  try { target = await deps.fetchInfo(); } catch (e) { return `error:${(e as { code?: string })?.code === 'unpaired' ? 'unpaired' : 'info'}`; }
  const t0 = deps.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve) => {
      const done = (s: string) => resolve(s);
      const playing = () => { try { return av.getState() === 'PLAYING'; } catch { return false; } };
      timer = setTimeout(() => done('error:timeout'), PLAY_TIMEOUT_MS);
      try {
        av.open(target.url);
        av.setListener({
          oncurrentplaytime: () => { if (playing()) done(`ok:${deps.now() - t0}ms`); },
          onbufferingcomplete: () => { if (playing()) done(`ok:${deps.now() - t0}ms`); },
          onerror: (e: unknown) => done(`error:${errCode(e, 'unknown')}`),
        });
        av.prepareAsync(() => { try { av.play(); } catch (e) { done(`error:${errCode(e, 'play')}`); } }, (e: unknown) => done(`error:${errCode(e, 'prepare')}`));
      } catch (e) { done(`error:${errCode(e, 'open')}`); }
    });
  } finally {
    clearTimeout(timer);
    try { av.stop(); } catch { /* not playing */ }
    try { av.close(); } catch { /* already closed */ }
    await Promise.resolve(target.report()).catch(() => undefined); // frees the server's stream slot, exactly once per open
  }
}

async function keyCheck(deps: ProbeDeps): Promise<ProbeResult['keys']> {
  try { deps.tizen!.tvinputdevice!.registerKey('MediaPlayPause'); } catch { return 'error'; }
  return (await deps.waitKey(KEY_TIMEOUT_MS)) ? 'ok' : 'timeout';
}

export async function runProbe(deps: ProbeDeps, onStage: (s: ProbeStage) => void = () => undefined): Promise<ProbeResult> {
  const av = deps.webapis?.avplay;
  onStage('play');
  const play = av ? await playCheck(av, deps) : 'skipped';
  onStage('key');
  const keys = await keyCheck(deps);
  let app: ProbeResult['app'] = 'missing';
  try { if (deps.tizen?.application?.getCurrentApplication?.()) app = 'ok'; } catch { /* stays missing */ }
  let tizen = '?', model = '?';
  try { tizen = token(deps.tizen?.systeminfo?.getCapability?.('http://tizen.org/feature/platform.version'), '?'); } catch { /* ? */ }
  try { model = token(deps.webapis?.productinfo?.getModel?.(), '?'); } catch { /* ? */ }
  onStage('done');
  return { avplay: av ? 'ok' : 'missing', play, keys, app, tizen, model };
}

/** the overlay runs only inside the app and only with probe=1 (remembered for the session, so it survives the pairing redirect) */
export function shouldProbe(win: TizenWin = window): boolean {
  if (!isTizenApp(win)) return false;
  try {
    if (new URLSearchParams(win.location?.search ?? '').get('probe') === '1') { win.sessionStorage?.setItem(PROBE_FLAG, '1'); return true; }
    return win.sessionStorage?.getItem(PROBE_FLAG) === '1';
  } catch { return false; }
}
export function endProbe(win: TizenWin = window) { try { (win.sessionStorage as Storage | undefined)?.removeItem(PROBE_FLAG); } catch { /* ignore */ } }

interface ItemRef { id: string }
interface InfoAnswer { playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string }

/** the real dependencies: the first Continue watching item, else the newest film/episode; no caps block (Task 7 adds it) */
export function realDeps(win: Window & typeof globalThis = window): ProbeDeps {
  const w = win as unknown as { webapis?: WebApisLike; tizen?: TizenLike };
  return {
    webapis: w.webapis,
    tizen: w.tizen,
    now: () => Date.now(),
    waitKey: (ms) => new Promise<boolean>((resolve) => {
      let code = 10252; // MediaPlayPause
      try { code = w.tizen?.tvinputdevice?.getKey?.('MediaPlayPause').code ?? code; } catch { /* default */ }
      const end = (v: boolean) => { clearTimeout(t); win.removeEventListener('keydown', on, true); resolve(v); };
      const on = (e: KeyboardEvent) => { if (e.keyCode === code || e.key === 'MediaPlayPause') end(true); };
      const t = setTimeout(() => end(false), ms);
      win.addEventListener('keydown', on, true);
    }),
    fetchInfo: async () => {
      const unpaired = () => Object.assign(new Error('unpaired'), { code: 'unpaired' });
      let paired = false;
      try { const me = await fetch('/api/me', { credentials: 'same-origin' }); paired = me.ok && Boolean((await me.json()).tv); } catch { /* offline */ }
      if (!paired) throw unpaired();
      let items = (await api<{ items: ItemRef[] }>('/api/library/resume')).items;
      if (!items?.length) items = (await api<{ items: ItemRef[] }>('/api/library/items?types=Movie,Episode&sort=DateCreated&desc=true&limit=1')).items;
      if (!items?.length) throw new Error('empty library');
      const itemId = items[0]!.id;
      const info = await api<InfoAnswer>('/api/playback/info', { method: 'POST', body: { itemId, reasonHint: 'network' } });
      const url = new URL(info.directUrl ?? info.hlsUrl, win.location.origin).href;
      const playMethod = info.directUrl ? 'DirectPlay' : 'Transcode';
      return { url, report: () => api('/api/playback/stop', { method: 'POST', body: { itemId, playSessionId: info.playSessionId, mediaSourceId: info.mediaSourceId, positionTicks: 0, isPaused: false, playMethod } }) };
    },
  };
}

// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The probe of the TV apps (LG webOS, Fire TV; spec section 6): on `/tv?probe=1&ff_app=<webos|firetv>` inside the app it checks the formats the TV
 * confirms, three real playbacks of one title (direct, hls.js, the TV's own HLS), the remote keys and the way back to the app's
 * start page ("Change server"), and condenses the answer into ONE line the owner can read out or photograph:
 *
 *   FFPROBE v1 tv=<webos|firetv> os=<ver|?> direct=<ok:<ms>ms|error:<code>> hls=<ok|error:<code>> nativehls=<ok|error:<code>>
 *     palm=<yes|no> home=<ok|fail|skipped> keys=<ok|missing:<names>|skipped> video=<codec[+10],…|-> audio=<codecs|-> containers=<list|->
 *     hlsvideo=<h264,hevc|-> surround=<eac3,ac3|-> ch=<2|6> [screen=<w>x<h>]   (screen: Fire TV only, the page's CSS viewport)
 *
 * `hlsvideo` / `surround` / `ch` are what the TV states for HLS streams (strict MSE `isTypeSupported`, as buildTvCaps): the video
 * codecs hls.js may be given, the Dolby surround codecs, and 6 channels when surround is not empty. (`hls=` above is the playback check.)
 *
 * Fire TV: `os` is '<Android version>/<model>'; the probe stops after the playbacks (keys=skipped home=skipped: the shell maps
 * the remote itself, and its Change server is a message, not a walk back through the history).
 *
 * `video=` lists codecs, `+10` when a 10-bit profile of it is confirmed. `direct=error:nodirect`: the server offered no direct URL.
 * A playback `error:<code>` is `timeout` (no picture within 15 s), `unpaired`, `profile`, `info` (the lookup failed), a media error
 * (`aborted`, `network`, `decode`, `format`), an hls.js error name, or `unsupported` / `load` (hls.js cannot run). The probe never
 * sends a progress report; the one stop report carries the title's resume point (lib/tvprobe/target.ts).
 *
 * The home check leaves the page: the result so far is stored in sessionStorage `ff.lgProbe`, goToAppHome() walks back to the
 * app's local start page, and that page opens the probe URL again with `&home=ok`, which restores the line. The hint is also read
 * from sessionStorage `ff.lgProbeHome` (lib/webos/probehome.ts), because a paired TV's /tv page may redirect to / and drop it from the URL. Everything the probe
 * touches is injected through LgProbeDeps so the tests need no TV.
 */
import { loadHls } from '#lib/player/hls';
import { fetchProbeTarget, type ProbeTarget } from '#lib/tvprobe/target';
import { isTvApp } from '#lib/tvapp';
import { fireTvOs, isFireTvApp, type FireWin } from '#lib/firetv/detect';
import { appCaps, confirmedTypes, hlsClaim, type MediaProbe } from './caps';
import { webosVersion, type LgWin } from './detect';
import { goToAppHome } from './home';
import { HOME_HINT_KEY, rememberLgProbeHome } from './probehome';

export const PLAY_TIMEOUT_MS = 15_000;
export const KEY_TIMEOUT_MS = 20_000;
/** how long the page waits to be left after goToAppHome() before it reports home=fail */
export const HOME_TIMEOUT_MS = 3_000;
/** the stop report must not hold the probe: the server's slot frees itself after a while anyway */
export const REPORT_TIMEOUT_MS = 5_000;
export const PROBE_FLAG = 'ff.probe';
export const RESULT_KEY = 'ff.lgProbe';
/** ⏯ (MediaPlayPause, or Play / Pause on remotes without it) and red */
export const PLAYPAUSE_CODES = [10252, 415, 19];
export const RED_CODES = [403];

/** the hidden test <video> (an HTMLVideoElement fits) */
export interface ProbeVideo {
  src: string;
  muted: boolean;
  error: { code?: number } | null;
  addEventListener(type: string, fn: () => void): void;
  play(): Promise<void> | void;
  remove(): void;
  removeAttribute?(name: string): void;
  load?(): void;
}
export interface LgProbeDeps {
  /** which TV app runs the probe */
  tv: 'webos' | 'firetv';
  /** `${innerWidth}x${innerHeight}` of the page */
  screen: string;
  /** canPlayType / isTypeSupported of this TV; null when there is no media element */
  media: MediaProbe | null;
  os: string | null;
  palm: boolean;
  /** rejects with `code: 'unpaired' | 'profile'` like fetchProbeTarget */
  fetchTarget: () => Promise<ProbeTarget>;
  now: () => number;
  createVideo: () => ProbeVideo;
  /** plays `url` through hls.js on the video; fatal errors go to onError; resolves to the teardown, rejects with `code` when hls.js cannot run */
  startHls: (video: ProbeVideo, url: string, onError: (code: string) => void) => Promise<() => void>;
  /** resolves true when one of the key codes is pressed, false after the timeout */
  waitKey: (codes: number[], timeoutMs: number) => Promise<boolean>;
  /** location.search of the page */
  search: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** goToAppHome(): false when the way back is unknown */
  goHome: () => boolean;
}
/** `hls` covers both HLS checks (detail 'native' for the TV's own); `keys` carries 'playpause' or 'red'; `home` is the Change server check */
export type LgProbeStage = 'formats' | 'direct' | 'hls' | 'keys' | 'home' | 'done';
export interface LgProbeResult {
  tv: 'webos' | 'firetv'; screen: string;
  os: string; direct: string; hls: string; nativehls: string; palm: 'yes' | 'no'; home: 'ok' | 'fail' | 'skipped'; keys: string;
  video: string[]; audio: string[]; containers: string[];
  hlsVideo: string[]; surround: string[]; ch: number;
}

const list = (a: string[]) => (a.length ? a.join(',') : '-');
export function formatLgProbe(r: LgProbeResult): string {
  const line = `FFPROBE v1 tv=${r.tv} os=${r.os} direct=${r.direct} hls=${r.hls} nativehls=${r.nativehls} palm=${r.palm} home=${r.home} keys=${r.keys} video=${list(r.video)} audio=${list(r.audio)} containers=${list(r.containers)} hlsvideo=${list(r.hlsVideo)} surround=${list(r.surround)} ch=${r.ch}`;
  return r.tv === 'firetv' ? `${line} screen=${r.screen}` : line;
}

const token = (v: unknown, fallback: string) => String(v ?? '').trim().replace(/\s+/g, '_') || fallback;
const MEDIA_ERRORS: Record<number, string> = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'format' };

/** one playback on a fresh hidden video: ok once `loadeddata` and `playing` were both seen, else the first error or the timeout */
async function playCheck(deps: LgProbeDeps, attach: (v: ProbeVideo, fail: (code: string) => void) => Promise<(() => void) | undefined>): Promise<string> {
  const t0 = deps.now();
  let video: ProbeVideo | null = null;
  let detach: (() => void) | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve) => {
      const done = (s: string) => resolve(s);
      timer = setTimeout(() => done('error:timeout'), PLAY_TIMEOUT_MS);
      let loaded = false, playing = false;
      const check = () => { if (loaded && playing) done(`ok:${deps.now() - t0}ms`); };
      let v: ProbeVideo;
      try { v = video = deps.createVideo(); } catch { done('error:video'); return; }
      try { v.muted = true; } catch { /* stays as it is */ }
      v.addEventListener('loadeddata', () => { loaded = true; check(); });
      v.addEventListener('playing', () => { playing = true; check(); });
      v.addEventListener('error', () => done(`error:${MEDIA_ERRORS[v.error?.code ?? 0] ?? 'media'}`));
      const fail = (code: string) => done(`error:${token(code, 'unknown')}`);
      attach(v, fail).then((d) => {
        if (finished) { try { d?.(); } catch { /* gone */ } return; }
        detach = d;
        try { void Promise.resolve(v.play()).catch((e: unknown) => fail((e as { name?: string })?.name ?? 'play')); } catch (e) { fail((e as { name?: string })?.name ?? 'play'); }
      }, (e: unknown) => fail((e as { code?: string })?.code ?? 'load'));
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    try { detach?.(); } catch { /* already gone */ }
    const v = video as ProbeVideo | null;
    if (v) {
      try { v.removeAttribute?.('src'); v.load?.(); } catch { /* frees the decoder where it can */ }
      try { v.remove(); } catch { /* already gone */ }
    }
  }
}

async function report(target: ProbeTarget): Promise<void> {
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve().then(() => target.report()).catch(() => undefined),
    new Promise((r) => { giveUp = setTimeout(r, REPORT_TIMEOUT_MS); }),
  ]);
  clearTimeout(giveUp);
}

/** a profile name with a standalone 10 ('main 10', 'high 10') */
export const isTenBitProfile = (profile: string) => /(^|\s)10(\s|$)/.test(profile);
/** `codec:profile` entries -> one token per codec in order, with `+10` when any 10-bit profile of it is confirmed */
export function videoTokens(entries: string[]): string[] {
  const ten = new Map<string, boolean>();
  for (const e of entries) {
    const i = e.indexOf(':');
    const codec = i < 0 ? e : e.slice(0, i);
    ten.set(codec, (ten.get(codec) ?? false) || (i >= 0 && isTenBitProfile(e.slice(i + 1))));
  }
  return [...ten].map(([c, t]) => (t ? `${c}+10` : c));
}

type Stored = LgProbeResult & { stage: 'home' | 'done' };
const strs = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');

function readStored(deps: LgProbeDeps): Stored | null {
  try {
    const raw = deps.storage?.getItem(RESULT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<Stored>;
    if (!o || typeof o !== 'object') return null;
    if (![o.os, o.direct, o.hls, o.nativehls, o.keys].every((x) => typeof x === 'string') || !strs(o.video) || !strs(o.audio) || !strs(o.containers)) return null;
    return {
      tv: o.tv === 'firetv' ? 'firetv' : 'webos', screen: typeof o.screen === 'string' ? o.screen : '?',
      os: o.os!, direct: o.direct!, hls: o.hls!, nativehls: o.nativehls!, palm: o.palm === 'yes' ? 'yes' : 'no',
      home: o.home === 'ok' ? 'ok' : o.home === 'skipped' ? 'skipped' : 'fail', keys: o.keys!,
      video: o.video, audio: o.audio, containers: o.containers,
      hlsVideo: strs(o.hlsVideo) ? o.hlsVideo : [], surround: strs(o.surround) ? o.surround : [], ch: typeof o.ch === 'number' ? o.ch : 2, stage: o.stage === 'done' ? 'done' : 'home',
    };
  } catch { return null; }
}
function store(deps: LgProbeDeps, r: LgProbeResult, stage: Stored['stage']): boolean {
  try { deps.storage!.setItem(RESULT_KEY, JSON.stringify({ ...r, stage })); return true; } catch { return false; }
}
const strip = ({ stage: _s, ...r }: Stored): LgProbeResult => r;

function homeHint(deps: LgProbeDeps): string | null {
  try { return deps.storage?.getItem(HOME_HINT_KEY) ?? null; } catch { return null; }
}
function clearHomeHint(deps: LgProbeDeps): void {
  try { deps.storage?.removeItem(HOME_HINT_KEY); } catch { /* blocked */ }
}

export async function runLgProbe(deps: LgProbeDeps, onStage: (s: LgProbeStage, detail?: string) => void = () => undefined): Promise<LgProbeResult> {
  const homeParam = new URLSearchParams(deps.search).get('home') ?? homeHint(deps);
  const stored = readStored(deps);
  if (stored) {
    // back from the home check (home=ok), or the same page again after a reload (/tv sends a paired TV to /): never play again
    let home = stored.home;
    if (homeParam === 'ok') home = 'ok';
    else if (stored.stage === 'home') home = 'fail'; // left, but landed on a server page instead of the start page
    const r = { ...strip(stored), home };
    if (store(deps, r, 'done')) clearHomeHint(deps); // the stored result now carries home: the hint has done its job
    onStage('done');
    return r;
  }

  onStage('formats');
  const t = confirmedTypes(deps.media);
  const claim = hlsClaim(deps.media, t.video.some((v) => v.startsWith('hevc:')));
  const r: LgProbeResult = {
    tv: deps.tv, screen: token(deps.screen, '?'),
    os: token(deps.os, '?'), direct: 'skipped', hls: 'skipped', nativehls: 'skipped', palm: deps.palm ? 'yes' : 'no', home: 'skipped', keys: 'skipped',
    video: videoTokens(t.video), audio: t.audio, containers: t.containers,
    hlsVideo: claim?.video ?? [], surround: claim?.surround ?? [], ch: claim?.surround.length ? 6 : 2,
  };

  onStage('direct');
  let target: ProbeTarget | null = null;
  try { target = await deps.fetchTarget(); } catch (e) {
    const code = (e as { code?: string })?.code;
    r.direct = r.hls = r.nativehls = `error:${code === 'unpaired' || code === 'profile' ? code : 'info'}`;
  }
  if (target) {
    const tg = target;
    try {
      // without a direct URL the server chose the converted stream: playing tg.url would be an HLS check reported as direct
      r.direct = tg.direct ? await playCheck(deps, async (v) => { v.src = tg.url; return undefined; }) : 'error:nodirect';
      onStage('hls');
      r.hls = (await playCheck(deps, (v, fail) => deps.startHls(v, tg.hlsUrl, fail))).replace(/^ok:.*/, 'ok');
      onStage('hls', 'native');
      r.nativehls = (await playCheck(deps, async (v) => { v.src = tg.hlsUrl; return undefined; })).replace(/^ok:.*/, 'ok');
    } finally {
      await report(tg); // frees the server's stream slot, once for the three playbacks
    }
  }
  // unpaired (the compact strip on the pairing page): no key test and no leaving the page; the probe runs again after pairing
  if (r.direct === 'error:unpaired') { onStage('done'); return r; }
  // Fire TV: the shell maps the remote and changes the server by message, so there is nothing more to test on the page
  if (deps.tv === 'firetv') { onStage('done'); return r; }

  onStage('keys', 'playpause');
  const pp = await deps.waitKey(PLAYPAUSE_CODES, KEY_TIMEOUT_MS);
  onStage('keys', 'red');
  const red = await deps.waitKey(RED_CODES, KEY_TIMEOUT_MS);
  const missing = [pp ? '' : 'playpause', red ? '' : 'red'].filter(Boolean);
  r.keys = missing.length ? `missing:${missing.join(',')}` : 'ok';

  if (homeParam !== null) {
    // the start page already sent us back here, but nothing was stored: the way home works, do not leave again
    r.home = homeParam === 'ok' ? 'ok' : 'skipped';
    clearHomeHint(deps);
    onStage('done');
    return r;
  }
  onStage('home');
  r.home = 'fail';
  if (!store(deps, r, 'home')) { r.home = 'skipped'; onStage('done'); return r; } // the result could not come back: stay
  let left = false;
  try { left = deps.goHome(); } catch { /* counts as not left */ }
  if (left) await new Promise((res) => setTimeout(res, HOME_TIMEOUT_MS)); // the page normally goes away during this wait
  store(deps, r, 'done');
  onStage('done');
  return r;
}

/** the overlay runs only inside a TV app and only with probe=1 (remembered for the session, so it survives the pairing redirect) */
export function shouldLgProbe(win: LgWin & FireWin = window): boolean {
  if (!isTvApp(win)) return false;
  rememberLgProbeHome(win);
  try {
    if (new URLSearchParams(win.location?.search ?? '').get('probe') === '1') { win.sessionStorage?.setItem(PROBE_FLAG, '1'); return true; }
    return win.sessionStorage?.getItem(PROBE_FLAG) === '1';
  } catch { return false; }
}
/** Back on the result: the probe and its stored result end for this session */
export function endLgProbe(win: { sessionStorage?: Pick<Storage, 'removeItem'> } = window) {
  try { win.sessionStorage?.removeItem(PROBE_FLAG); win.sessionStorage?.removeItem(RESULT_KEY); win.sessionStorage?.removeItem(HOME_HINT_KEY); } catch { /* ignore */ }
}
/** Back closes the probe for good, except from the compact strip on the pairing page while the TV is unpaired (the full-screen probe must still run after pairing) */
export function shouldEndLgProbe(compact: boolean, line: string): boolean {
  return !(compact && line.includes('direct=error:unpaired'));
}
/** the line when the probe itself crashed */
export function failedLgProbeLine(win: LgWin & FireWin = window): string {
  const fire = isFireTvApp(win);
  return formatLgProbe({
    tv: fire ? 'firetv' : 'webos', screen: screenOf(win),
    os: token(fire ? fireTvOs(win) : webosVersion(win), '?'), direct: 'error:unknown', hls: 'skipped', nativehls: 'skipped', palm: !fire && typeof win.PalmSystem !== 'undefined' ? 'yes' : 'no',
    home: 'skipped', keys: 'skipped', video: [], audio: [], containers: [], hlsVideo: [], surround: [], ch: 2,
  });
}

const screenOf = (win: FireWin) => `${win.innerWidth ?? '?'}x${win.innerHeight ?? '?'}`;
const coded = (code: string) => Object.assign(new Error(code), { code });

/** the real dependencies: the shared probe target with this TV's caps block, one hidden <video> per playback */
export function realLgDeps(win: Window & typeof globalThis = window, fetchImpl: typeof fetch = (...a) => fetch(...a)): LgProbeDeps {
  const doc = win.document;
  let media: MediaProbe | null = null;
  try {
    const v = doc.createElement('video');
    const ms = (win as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
    media = { canPlayType: (t) => v.canPlayType(t), isTypeSupported: ms?.isTypeSupported ? (t) => ms.isTypeSupported!(t) : undefined };
  } catch { /* no media element */ }
  let storage: LgProbeDeps['storage'];
  try { storage = win.sessionStorage; } catch { /* blocked */ }
  const fire = isFireTvApp(win as unknown as FireWin);
  return {
    tv: fire ? 'firetv' : 'webos',
    screen: screenOf(win as unknown as FireWin),
    media,
    os: fire ? fireTvOs(win as unknown as FireWin) : webosVersion(win),
    palm: !fire && typeof (win as unknown as LgWin).PalmSystem !== 'undefined',
    fetchTarget: () => fetchProbeTarget(win, fetchImpl, { caps: appCaps() ?? undefined }),
    now: () => Date.now(),
    createVideo: () => {
      const v = doc.createElement('video');
      v.setAttribute('aria-hidden', 'true');
      v.playsInline = true;
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1';
      doc.body.appendChild(v);
      return v;
    },
    startHls: async (video, url, onError) => {
      let Hls: Awaited<ReturnType<typeof loadHls>>;
      try { Hls = await loadHls(); } catch { throw coded('load'); }
      if (!Hls.isSupported()) throw coded('unsupported');
      const h = new Hls();
      h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) onError(String(d.details)); });
      h.loadSource(url);
      h.attachMedia(video as HTMLVideoElement);
      return () => h.destroy();
    },
    waitKey: (codes, ms) => new Promise<boolean>((resolve) => {
      const end = (v: boolean) => { clearTimeout(t); win.removeEventListener('keydown', on, true); resolve(v); };
      const on = (e: KeyboardEvent) => { if (codes.includes(e.keyCode)) { e.preventDefault(); e.stopPropagation(); end(true); } };
      const t = setTimeout(() => end(false), ms);
      win.addEventListener('keydown', on, true);
    }),
    search: win.location.search,
    storage,
    goHome: () => goToAppHome(win),
  };
}
